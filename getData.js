const fs = require("fs")
const path = require("path")
const http = require("http")
const https = require("https")
const airtable = require("airtable")
const crypto = require('crypto')
require('dotenv').config()

const DEFAULT_IMAGE_PATH = "assets/images/missing_image.png"
const MAX_REDIRECTS = 5
const DOWNLOAD_TIMEOUT_MS = 20000

function normalizeAttachmentField(fieldValue) {
    if (!fieldValue) return null
    if (Array.isArray(fieldValue)) {
        const attachmentWithUrl = fieldValue.find(item => item && item.url)
        return attachmentWithUrl ? attachmentWithUrl.url : null
    }
    if (typeof fieldValue === "string") {
        return fieldValue.trim()
    }
    return null
}

function extractGoogleDriveId(url) {
    if (!url || typeof url !== "string") return null

    const patterns = [
        /\/d\/([a-zA-Z0-9_-]+)/,                  // https://drive.google.com/file/d/<id>/view
        /id=([a-zA-Z0-9_-]+)/,                    // https://drive.google.com/open?id=<id> or uc?id=
        /\/open\?id=([a-zA-Z0-9_-]+)/,            // explicit open?id=
        /\/uc\?export=download&id=([a-zA-Z0-9_-]+)/,
    ]

    for (const pattern of patterns) {
        const match = url.match(pattern)
        if (match && match[1]) {
            return match[1]
        }
    }
    return null
}

function ensureDirectoryExists(filePath) {
    const dir = path.dirname(filePath)
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
    }
}

function downloadFile(fileUrl, localPath, attempt = 0) {
    return new Promise((resolve) => {
        if (!fileUrl) {
            return resolve(false)
        }

        if (attempt > MAX_REDIRECTS) {
            console.error(`Too many redirects while fetching ${fileUrl}`)
            return resolve(false)
        }

        let parsedUrl
        try {
            parsedUrl = new URL(fileUrl)
        } catch (error) {
            console.error(`Invalid URL for download: ${fileUrl}`, error)
            return resolve(false)
        }

        const protocol = parsedUrl.protocol === "http:" ? http : https

        // Plenty of image hosts reject requests that do not look like a browser -
        // without these headers they answer 403 and a perfectly good image would be
        // downgraded to a gradient placeholder.
        const requestOptions = {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
                    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
                "Referer": `${parsedUrl.origin}/`
            }
        }

        const request = protocol.get(parsedUrl, requestOptions, res => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                const redirectUrl = new URL(res.headers.location, parsedUrl).href
                res.resume()
                return resolve(downloadFile(redirectUrl, localPath, attempt + 1))
            }

            if (res.statusCode !== 200) {
                console.error(`Failed to download ${fileUrl}. Status code: ${res.statusCode}`)
                res.resume()
                return resolve(false)
            }

            ensureDirectoryExists(localPath)

            const fileStream = fs.createWriteStream(localPath)
            res.pipe(fileStream)

            fileStream.on("finish", () => {
                fileStream.close(() => resolve(true))
            })

            fileStream.on("error", err => {
                console.error(`Error writing file ${localPath}`, err)
                fs.unlink(localPath, () => resolve(false))
            })
        })

        // Without this, a host that accepts the connection but never answers hangs the
        // request forever - Promise.all never settles and the build never writes
        // data.json. Several of the rotted image hosts behave exactly that way.
        request.setTimeout(DOWNLOAD_TIMEOUT_MS, () => {
            console.error(`Timed out after ${DOWNLOAD_TIMEOUT_MS}ms downloading ${fileUrl}`)
            request.destroy()
            resolve(false)
        })

        request.on("error", err => {
            console.error(`Request error while downloading ${fileUrl}`, err)
            resolve(false)
        })
    })
}

// Reads intrinsic width/height straight from the file header. Downloads are all
// saved with a .png extension regardless of what the server actually sent, so the
// format is sniffed from magic bytes rather than trusted from the name. Avoids
// pulling in an image library, which would have to build on Vercel too.
// Some hosts answer a hotlink with a bot-block notice rendered as a perfectly valid
// image and HTTP 200 - vectorstock serves an "Access Restricted" card that way, and
// three projects ended up displaying it. The tell is that the bytes come back
// identical across unrelated projects; real project artwork never repeats. Drop
// those so the card falls back to its subject gradient instead.
function dropSharedPlaceholderImages(projects) {
    const byHash = {}
    projects.forEach(proj => {
        const link = proj.graphic_link
        if (!link || link.indexOf("/assets/") !== 0) return
        const file = path.join(__dirname, "src", link.replace(/^\//, ""))
        let hash
        try {
            hash = crypto.createHash("sha1").update(fs.readFileSync(file)).digest("hex")
        } catch (error) {
            return
        }
        if (!byHash[hash]) byHash[hash] = []
        byHash[hash].push(proj)
    })
    Object.keys(byHash).forEach(hash => {
        const group = byHash[hash]
        // count distinct projects - the duplicated Airtable rows share a project_id
        // and legitimately share one picture, so they must not trip this
        const ids = {}
        group.forEach(p => { ids[p.project_id] = 1 })
        // Three or more is the threshold: two unrelated projects genuinely do share a
        // picture in this dataset, so a pair is not evidence of a block page.
        if (Object.keys(ids).length < 3) return
        console.log("Dropping an image shared by " + Object.keys(ids).length +
                    " unrelated projects (almost certainly a block page): " +
                    group.map(p => p.project_title).join(" | "))
        group.forEach(p => { p.graphic_link = null; delete p.hero_w; delete p.hero_h })
    })
}

function imageSize(file) {
    let buf
    try {
        const fd = fs.openSync(file, "r")
        buf = Buffer.alloc(65536)
        const read = fs.readSync(fd, buf, 0, 65536, 0)
        fs.closeSync(fd)
        buf = buf.slice(0, read)
    } catch (error) {
        return null
    }
    if (buf.length < 24) return null

    // PNG
    if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
    }
    // GIF
    if (buf.slice(0, 3).toString("latin1") === "GIF") {
        return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
    }
    // WebP (VP8X / VP8 / VP8L)
    if (buf.slice(0, 4).toString("latin1") === "RIFF" && buf.slice(8, 12).toString("latin1") === "WEBP") {
        const type = buf.slice(12, 16).toString("latin1")
        if (type === "VP8X") {
            return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) }
        }
        if (type === "VP8 ") {
            return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff }
        }
        if (type === "VP8L") {
            const b = buf.readUInt32LE(21)
            return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 }
        }
        return null
    }
    // JPEG - walk the segment markers to the frame header
    if (buf[0] === 0xff && buf[1] === 0xd8) {
        let i = 2
        while (i < buf.length - 9) {
            if (buf[i] !== 0xff) { i++; continue }
            const marker = buf[i + 1]
            // SOF0-SOF15, excluding the non-frame markers DHT/JPG/DAC
            if (marker >= 0xc0 && marker <= 0xcf &&
                marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
                return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) }
            }
            i += 2 + buf.readUInt16BE(i + 2)
        }
    }
    return null
}

function getLocalImagePaths(identifier, folder) {
    const hash = crypto.createHash("sha1").update(identifier).digest("hex")
    const fileName = `${hash}.png`

    return {
        absolute: path.join(__dirname, "src", "assets", "images", folder, fileName),
        relative: `assets/images/${folder}/${fileName}`
    }
}

function resolveImageDownload(link, type) {
    if (!link) {
        return Promise.resolve(type === "hero" ? null : DEFAULT_IMAGE_PATH)
    }

    const folder = type === "mentor" ? "mentor_imgs"
        : type === "hero" ? "project_graphics"
        : "student_imgs"
    // A hero that will not download should leave graphic_link empty so the card
    // falls back to its subject gradient, not to the grey missing-image box.
    const fallback = type === "hero" ? null : DEFAULT_IMAGE_PATH
    const driveId = extractGoogleDriveId(link)
    let identifier = driveId || link

    if (!driveId) {
        try {
            const parsed = new URL(link)
            identifier = `${parsed.origin}${parsed.pathname}`
        } catch (error) {
            identifier = link
        }
    }

    const { absolute, relative } = getLocalImagePaths(identifier, folder)

    if (fs.existsSync(absolute)) {
        return Promise.resolve(relative)
    }

    const downloadUrl = driveId
        ? `https://www.googleapis.com/drive/v3/files/${driveId}?alt=media&key=${process.env.GOOGLE_API_KEY}`
        : link

    return downloadFile(downloadUrl, absolute).then(success => {
        if (success) {
            return relative
        }
        return fallback
    })
}

airtableData = []

airtable.configure({
    endpointUrl: 'https://api.airtable.com',
    requestTimeout: 30000
});

let base = airtable.base(process.env.AIRTABLE_BASE_ID, {
    headers: {
        'Authorization': `Bearer ${process.env.AIRTABLE_API_KEY}`
    }
});

projectData = {
    projects: [],
    topics: new Set(),
    tags: new Set(),
    tagsMap: {},
}

const basePromise = new Promise((resolve, reject) => {
    base(process.env.AIRTABLE_BASE_PROJECTS_NAME).select({
        maxRecords: 500,
        view: "Grid view"
    }).eachPage(function page(records, fetchNextPage) {
        records.forEach(function(record) {
            // Airtable's own creation timestamp is the only date left to order by (the
            // "Project Completed Year/Season" fields no longer exist), so keep it before the
            // record is reduced to its fields.
            const createdTime = record._rawJson && record._rawJson.createdTime;
            record = record.fields;
            if (createdTime) record.__createdTime = createdTime;
            if(record['Image Link'] && record['Mentee Name']){
                airtableData.push(record)
            }
        });
        fetchNextPage();

    }, function done(err) {
        if (err) { 
            console.error(err); 
            reject(err)
            return; 
        }
        airtableData = airtableData.filter(item => !item.Permissions.includes("I would not like my work to be showcased on the Inspirit AI website"));
        airtableData = airtableData.filter(item => item.Permissions.includes("Project Title and Abstract"));
        airtableData.forEach((item, index, array) => {
            if(!item.Permissions.includes("Research paper")){
                array[index]["Research Paper Link"] = undefined;
            }
            if(!item.Permissions.includes("Github/codebase link")){
                array[index]["Github Repo/Other Code File Links (optional)"] = undefined;
            }
            if(item["Github Repo/Other Code File Links (optional)"])
                if(item["Github Repo/Other Code File Links (optional)"].search(/colab/i) > -1)
                    array[index]["Github Repo/Other Code File Links (optional)"] = undefined;

            if(!item.Permissions.includes("Web application")){
                array[index]["Link to Project Webpage (optional)"] = undefined;
            }
            let tempObj = {};
            const menteeName = item["Mentee Name"] || "";
            const menteeNameParts = menteeName.trim().split(" ").filter(Boolean);
            const firstName = menteeNameParts[0] || "";
            const lastInitial = menteeNameParts[1] ? `${menteeNameParts[1][0]}.` : "";
            tempObj["student_name"] = [firstName, lastInitial].filter(Boolean).join(" ");
            tempObj["mentor_name"] = item["Mentor Name"];
            tempObj["mentor_title"] = item["Mentor Title"];
            tempObj["mentor_image"] = normalizeAttachmentField(item["Mentor Picture Link (optional)"]);
            tempObj["student_image"] = normalizeAttachmentField(item["Mentee Picture Link (optional)"]);
            tempObj["domains"] = [item["Domain 1"], item["Domain 2"]].filter(item=>item);
            tempObj["project_title"] = item["Project Title"];
            tempObj["project_desc"] = item["Project Description"];
            tempObj["research_paper"] = item["Research Paper Link"];
            tempObj["project_yr"] = item["Project Completed Year"];
            tempObj["project_quarter"] = item["Project Completed Season"];
            tempObj["github"] = item["Github Repo/Other Code File Links (optional)"];
            tempObj["project_webpage"] = item["Link to Project Webpage (optional)"];
            // Accepts either a pasted URL or an Airtable attachment. Attachment URLs expire,
            // so whichever form it takes, the image is downloaded below and served locally.
            // Ronil added an "Image Attachment" column because copying links into the
            // attachment field was cumbersome. Prefer it, fall back to "Image Link".
            tempObj["graphic_link"] = normalizeAttachmentField(item["Image Attachment"])
                || normalizeAttachmentField(item["Image Link"]);
            tempObj["headline"] = item["Headline"];
            tempObj["project_id"] = crypto.createHash('sha1').update(`${item["Project Title"]}${item["Mentee Name"]}`).digest('hex');
            tempObj["expand"] = item["Project Title"].length > 75 ? true : false;
            tempObj["tags"] = Array.isArray(item["Tags"]) ? item["Tags"] : [];
            tempObj["published"] = item["Published"];
            tempObj["publications"] = item["Publications"];
            tempObj["science_fairs"] = item["Science Fairs"];
            tempObj["publication_link"] = item["Publication Link"];
            tempObj["created_at"] = item.__createdTime || null;
            projectData.projects.push(tempObj);

            // tempObj.domains.forEach(topic => projectData.topics.add(topic));
            tempObj.tags.forEach(tag => projectData.tags.add(tag));
        })
        function getRandomInt(max) {
          return Math.floor(Math.random() * max);
        }

        function shuffle(array) {
            let currentIndex = array.length, randomIndex;
            while (currentIndex != 0) {
                randomIndex = Math.floor(Math.random() * currentIndex);
                currentIndex--;
                [array[currentIndex], array[randomIndex]] = [
                array[randomIndex], array[currentIndex]];
            }
            return array;
        }

        // The front page reuses the server-rendered cards as-is instead of re-sorting them, so
        // the build must emit projects already in display order: published first, then newest
        // first — the same rule as dataService.sortProjects. This has to run before related_proj
        // below, because related projects are stored as indices into this array.
        const createdMs = (project) => {
            const t = Date.parse(project.created_at || '');
            return Number.isNaN(t) ? 0 : t;
        };
        projectData.projects.sort((a, b) => {
            const published = (b.published === true ? 1 : 0) - (a.published === true ? 1 : 0);
            if (published !== 0) return published;
            return createdMs(b) - createdMs(a);
        });

        let projData = {}
        projData.projects = projectData.projects.map((item, curr_index) => {
          let related = [];
          projectData.projects.forEach((entry, rel_index) =>{
            if(item.domains.filter(value => entry.domains.includes(value)).length > 0){
              if(curr_index != rel_index)
                  related.push(rel_index);
            }
          });
          related = shuffle(related).splice(0, 3);
          let rand_index = 0;
          while(related.length < 3){
            rand_index = getRandomInt(projectData.projects.length);
            if(!related.includes(projectData.projects[rand_index]) && curr_index != rand_index)
                related.push(rand_index);
          }
          item["related_proj"] = related;
          return item;
        });
        projectData.topics = Array.from(projectData.topics).sort();
        projectData.tags = Array.from(projectData.tags).sort();

        // fs.writeFileSync('./data.json', JSON.stringify(projectData, null, 2) , 'utf-8');
        resolve();
    });
});


let domainsPromise = new Promise((resolve, reject) => { setTimeout(() => {}, 10000); resolve(); });

Promise.all([basePromise]).then(() => { 
    domainsPromise = new Promise((resolve, reject) => {
        base(process.env.AIRTABLE_BASE_DOMAINS_NAME).select({
            maxRecords: 500,
            view: "Grid view" 
        }).eachPage(function page(records, fetchNextPage) {
            records.forEach(function(record) {
                record = record.fields;
                projectData.tagsMap[record["Name"]] = record["Tags"].sort()
                projectData.topics.push(record["Name"])
            });
            projectData.topics = projectData.topics.sort()
            fetchNextPage();

        }, function done(err) {
            if (err) { 
                console.error(err); 
                reject();
                return; 
            }
            resolve();
        });
    });
});

Promise.all([domainsPromise, basePromise]).then(() => {
    let image_promises = []

    projectData.projects.forEach((project, index, array) => {
        if(index % 5 == 0) setTimeout(() => {}, 1000)

        const mentorPromise = resolveImageDownload(project.mentor_image, "mentor")
            .then(localPath => {
                array[index].mentor_image = localPath || DEFAULT_IMAGE_PATH
            })
            .catch(error => {
                console.error(`Failed to process mentor image for project ${project.project_title}`, error)
                array[index].mentor_image = DEFAULT_IMAGE_PATH
            })
        image_promises.push(mentorPromise)

        const studentPromise = resolveImageDownload(project.student_image, "student")
            .then(localPath => {
                array[index].student_image = localPath || DEFAULT_IMAGE_PATH
            })
            .catch(error => {
                console.error(`Failed to process student image for project ${project.project_title}`, error)
                array[index].student_image = DEFAULT_IMAGE_PATH
            })
        image_promises.push(studentPromise)

        // Hero images used to be hotlinked straight from whatever third-party site the
        // URL pointed at, which is why so many rotted (404/403/expired CDN links).
        // Download it once at build time and serve it from our own assets instead. The
        // path is root-absolute so it resolves from both / and /projects/*.html.
        const originalHero = project.graphic_link
        const heroPromise = resolveImageDownload(originalHero, "hero")
            .then(localPath => {
                // Keep the original URL when the download fails. A few hosts refuse our
                // request but still serve the image to a real browser, and downgrading
                // those to a gradient would lose a picture that currently displays.
                // Genuinely dead URLs are caught separately by dead-links.json.
                array[index].graphic_link = localPath ? `/${localPath}` : (originalHero || null)
                // Record the real shape so the gallery can lay cards out by aspect
                // ratio rather than forcing every one to the same height.
                if (localPath) {
                    const dims = imageSize(path.join(__dirname, "src", localPath))
                    if (dims && dims.width && dims.height) {
                        array[index].hero_w = dims.width
                        array[index].hero_h = dims.height
                    }
                }
            })
            .catch(error => {
                console.error(`Failed to process hero image for project ${project.project_title}`, error)
                array[index].graphic_link = originalHero || null
            })
        image_promises.push(heroPromise)

        if(project.research_paper != undefined){
            let research_paper_url = project.research_paper
            let research_paper_id = research_paper_url.substring(research_paper_url.indexOf("id=") + 3)
            let research_paper_api_link = `https://www.googleapis.com/drive/v3/files/${research_paper_id}?key=${process.env.GOOGLE_API_KEY}&alt=media`


            let research_paper_promise = new Promise((resolve, reject) => {
                https.get(research_paper_api_link, res => {
                    const local_id = crypto.createHash('sha1').update(`${research_paper_id}${research_paper_id}`).digest('hex');
                    const research_paper_local_url = `./src/assets/pdfs/${local_id}.pdf`
                    const file = fs.createWriteStream(research_paper_local_url)
                    res.pipe(file)
                    file.on('finish', () => {
                        file.close()
                        console.log(`PDF downloaded!`)
                        array[index].research_paper = `assets/pdfs/${local_id}.pdf`
                        resolve()
                    });
                }).on('error', (e) => {
                    console.error(e);
                    reject()
                });
            })
            image_promises.push(research_paper_promise)
        }
    })
    Promise.all(image_promises).then(() => {
        dropSharedPlaceholderImages(projectData.projects)
        fs.writeFileSync('./data.json', JSON.stringify(projectData, null, 2) , 'utf-8');
    })
});


