import styles from "../css/index.scss";
import din_condensed from "../assets/fonts/DIN Condensed Bold.ttf";
import din_condensed2 from "../assets/fonts/DIN Condensed Bold.otf";
import fatfrank from "../assets/fonts/FatFrank-Regular.otf";
import fatfrank2 from "../assets/fonts/FatFrank-Regular.ttf";
import dataService from "./dataService.js";
import { heroGradient } from "./heroBackground.js";
import { heroImgTag, avatarTag } from "./cardImages.js";

// import 'bootstrap';

let active_filters = []
let current_category = "Published Papers and Science Fairs"
let isInitialized = false
// renderResults() is declared inside the load handler below (it closes over the
// search state there), but renderAllProjects() at module level needs it too. The
// handler publishes it through this binding; until then it is a harmless no-op.
let renderResultsImpl = () => {}

// Show loading state
// Assigned inside the window-load callback below. It has to be declared out here
// because initializeSearch() (module scope) calls it, while its body needs
// executeSearch(), which only exists inside that callback's scope.
let renderSuggestions = function () {};

function showLoadingState() {
  const gallery = document.querySelector('.projectGallery');
  // Nothing to wait for when the cards are already server-rendered - replacing them
  // with a spinner threw away the pre-rendered gallery and forced a full rebuild,
  // which is what moved the footer and drove the page's layout shift.
  if (gallery && gallery.querySelector('.projectContainer')) return;
  if (gallery) {
    gallery.innerHTML = `
      <div class="loading-container text-center font-secondary h2 pt-5">
        <div class="spinner-border text-primary" role="status">
          <span class="sr-only">Loading...</span>
        </div>
        <div class="mt-3">Loading published projects...</div>
      </div>
    `;
  }
}

// Initialize the application with progressive loading
async function initializeApp() {
  if (isInitialized) return;
  isInitialized = true;

  try {
    // Show loading state immediately
    showLoadingState();
    
    // Load filter data first (lightweight)
    await dataService.loadFilterData();
    
    // Initialize filters and search functionality
    initializeFilters();
    initializeSearch();
    
    // Load projects in the background
    dataService.onProjectsLoaded((projects) => {
      // Get all sorted projects from dataService, then filter to published only
      const allSortedProjects = dataService.getProjects();
      const publishedProjects = allSortedProjects.filter(project => project.published === true);
      renderAllProjects(publishedProjects);
    });
    
    // Start loading projects
    await dataService.loadProjects();
    
  } catch (error) {
    console.error('Failed to initialize app:', error);
    showErrorState();
  }
}

// Initialize filters with loaded data
function initializeFilters() {
  const topics = dataService.getTopics();
  
  // Populate domain dropdown
  const selectElement = document.querySelector("#searchCategories");
  if (selectElement) {
    // Clear existing options except the first one
    selectElement.innerHTML = '<option value="" disabled>Select Domain!</option><option value="No Domain">No Domain</option>';
    
    topics.forEach(topic => {
      const option = document.createElement('option');
      option.value = topic;
      option.textContent = topic;
      if (topic === "Published Papers and Science Fairs") {
        option.selected = true;
      }
      selectElement.appendChild(option);
    });
  }
}

// Initialize search functionality
function initializeSearch() {
  document.getElementById('searchBar').onclick = (e) => {
    document.querySelector(".searchSuggestions").style.display = "flex";
    let queryString = e.target.value;

    let autocompleteResults = []
    if(current_category != "" && current_category != "No Domain"){
      const tagsMap = dataService.getTagsMap();
      autocompleteResults = (tagsMap[current_category] || []).filter(x => 
        x.toLowerCase().startsWith(queryString.toLowerCase().trim()) ||
        x.toLowerCase().split(" ").includes(queryString.toLowerCase().trim())
      )
    }
    else{
      const tags = dataService.getTags();
      autocompleteResults = tags.filter(x => 
        x.toLowerCase().startsWith(queryString.toLowerCase().trim()) ||
        x.toLowerCase().split(" ").includes(queryString.toLowerCase().trim())
      )
    }
    renderSuggestions(autocompleteResults)
  }
  
  document.getElementById('searchBar').onkeyup = document.getElementById('searchBar').onclick;
}

// Render all projects (replaces the server-side rendered projects)
function renderAllProjects(projects) {
  const gallery = document.querySelector('.projectGallery');
  if (!gallery) return;

  // The cards are already in the HTML - server-rendered so crawlers can follow them
  // and the gallery paints before this script runs. Tearing them down and rebuilding
  // identical ones empties the container and refills it, which moves the footer twice
  // and accounted for most of the page's layout shift. Reuse them when they match;
  // filtering works off [data-id], which the server-rendered cards already carry.
  const prerendered = gallery.querySelectorAll('.projectContainer');
  if (prerendered.length === projects.length) {
    if (!gallery.querySelector('.galleryError')) {
      const err = document.createElement('div');
      err.className = 'galleryError text-center font-secondary h2 pt-5';
      err.style.display = 'none';
      err.textContent = 'Sorry, no projects match those filters :(';
      gallery.insertBefore(err, gallery.firstChild);
    }
    renderResultsImpl();
    return;
  }

  gallery.innerHTML = '';
  
  // Add error message element
  const errorDiv = document.createElement('div');
  errorDiv.className = 'galleryError text-center font-secondary h2 pt-5';
  errorDiv.style.display = 'none';
  errorDiv.textContent = 'Sorry, no projects match those filters :(';
  gallery.appendChild(errorDiv);
  
  // Render all projects
  projects.forEach(project => {
    const projectElement = createProjectElement(project);
    gallery.appendChild(projectElement);
  });
  
  // Apply current filters
  renderResultsImpl();
}

// Create a project element
function createProjectElement(project) {
  const projectElement = document.createElement('div');
  projectElement.className = `projectContainer`;
  // Same masonry sizing as the main gallery - height follows the picture's real
  // shape, clamped so the overlay text still fits.
  const img = project.hero_img;
  const ratio = (img && img.w && img.h) ? img.h / img.w
    : (project.hero_w && project.hero_h) ? project.hero_h / project.hero_w : 0.87;
  projectElement.style.setProperty('--card-ratio', Math.min(1.15, Math.max(0.65, ratio)).toFixed(3));
  projectElement.setAttribute('data-id', project.project_id);
  projectElement.onclick = () => window.location = `projects/${project.project_id}.html`;
  
  const publishedRibbon = project.published ? `
    <div class="ribbonTooltip" style="${project.expand ? 'padding: 0.7% 1.75%;' : 'padding: 0.7% 0 0 1.75%;'}">
      ${project.publications || ''} ${project.science_fairs || ''}
      <span class="material-symbols-outlined ribbonIcon">workspace_premium</span>
    </div>
  ` : '';
  
  const contentHeight = project.published ? 'h-85' : 'h-100';
  
  projectElement.innerHTML = `
    <div class="projectSubContainer">
      <div class="projectImage" style="background:${heroGradient(project)}">
        ${heroImgTag(project)}
        ${publishedRibbon}
        <div class="${contentHeight} contentContainer w-100 d-flex flex-column justify-content-end p-2">
          <div class="hoverContainer">
            <div class="projectTitle text-white font-secondary m-0">
              ${project.project_title}
            </div>
            <hr class="contentDivider mx-auto my-1" />
            <div class="projectHeadline text-white font-text m-0" style="-webkit-line-clamp: 2;">
              ${project.headline}
            </div>
          </div>
          <div class="d-flex w-100 align-items-center">
            ${avatarTag(project.student_avatar)}
            <div class="meta-text text-white font-secondary m-0 ps-2 pt-1">
              ${project.student_name}
              ${project.project_yr ? `| ${project.project_quarter} ${project.project_yr}` : ''}
            </div>
          </div>
          <div class="d-flex w-100 justify-content-between align-items-center mentorImage">
            ${project.mentor_name && String(project.mentor_name).trim() && String(project.mentor_name).toLowerCase() !== 'undefined' ? `
              <div class="d-flex align-items-center">
                ${avatarTag(project.mentor_avatar)}
                <div class="meta-text text-white font-secondary m-0 ps-2 pt-1">
                  Mentored by ${project.mentor_name}
                </div>
              </div>
            ` : `<div></div>`}
            <img width="18" height="18" src="assets/images/arrow.png" class="backArrow me-2" alt="">
          </div>
        </div>
      </div>
    </div>
  `;
  
  return projectElement;
}

// Show error state
function showErrorState() {
  const gallery = document.querySelector('.projectGallery');
  if (gallery) {
    gallery.innerHTML = `
      <div class="error-container text-center font-secondary h2 pt-5">
        <div class="text-danger">Failed to load projects</div>
        <button class="btn btn-primary mt-3" onclick="location.reload()">Retry</button>
      </div>
    `;
  }
}

window.addEventListener('load', (event) => {
  renderResultsImpl = renderResults;   // function declaration below is hoisted
  // Initialize the app with progressive loading
  initializeApp();

  document.addEventListener('click', event => {
    const box = document.querySelector('.searchBarContainer');
    if (!box.contains(event.target)) {
      document.querySelector(".searchSuggestions").style.display = 'none';
    }
  });
  
  document.querySelector("#searchCategories").onchange = () => {
    document.getElementById('searchBar').value = ""
    current_category = document.querySelector("#searchCategories").value
    executeSearch("")
  }

  // Enter picks the first suggestion. Without it the box swallows Enter entirely,
  // which reads as a broken search - the only other way in is clicking a pill.
  document.getElementById('searchBar').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    const first = document.querySelector('.searchSuggestions > .searchPill')
    if (first) executeSearch(first.textContent)
  })

  function executeSearch(queryString) {
    let hasFilter = false
    active_filters.forEach((filter, index) => {
      if(filter.value == queryString){
        hasFilter = true
      }
    })

    if(hasFilter) return;
    
    const topics = dataService.getTopics();
    
    if((current_category == "No Domain" || current_category == "Misc" || current_category == "Specific Technologies") && queryString == ""){
      active_filters.forEach((filter, index, array) => {
        if(topics.includes(filter.value))
          array.splice(index, 1)
      })
    }
    else if(queryString == ""){
      active_filters.forEach((filter, index, array) => {
        if(topics.includes(filter.value))
          array.splice(index, 1)
      })
      active_filters.push({
        value: current_category,
      })
    } else {
      active_filters.push({
        value: queryString,
      })
    }
    document.querySelector("#searchBar").value = "";
    renderFilters();
    renderResults();
  }

  function deleteFilter(e){
    let value = e.path[1].getAttribute("data-value")
    active_filters.forEach((filter, index) => {
      if(filter.value == value){
        active_filters.splice(index, 1)
      }
    })
    // console.log(active_filters)
    renderFilters();
    renderResults();
  }

  function renderFilters() {
    document.querySelector(".activeFilters").innerHTML = ""

    const topics = dataService.getTopics();
    
    active_filters.forEach(filter => {
      if(filter.value == "" || topics.includes(filter.value)) return;
      document.querySelector(".activeFilters").innerHTML += `
        <div class="searchPill pr-2" data-value='${filter.value}'>
          ${filter.value} 
          <img class="closeIcon" src="assets/images/x_icon.svg" />
        </div>`;
    })
    Array.from(document.getElementsByClassName("closeIcon")).forEach(elem => {
      elem.onclick = (e) => {deleteFilter(e)};
    })
  }

  function renderResults() {
    if (!dataService.isProjectsLoaded()) {
      return; // Don't filter until projects are loaded
    }
    
    // Get only published projects
    const allProjects = dataService.getProjects();
    const publishedProjects = allProjects.filter(project => project.published === true);
    const filteredProjects = dataService.filterProjects(active_filters).filter(project => project.published === true);
    
    const projectElements = Array.from(document.getElementsByClassName("projectContainer"));
    
    // Hide all projects first
    projectElements.forEach(elem => {
      elem.style.display = "none";
    });
    
    // Show only filtered projects
    filteredProjects.forEach(project => {
      const projectElement = document.querySelector(`[data-id="${project.project_id}"]`);
      if (projectElement) {
        projectElement.style.display = "block";
      }
    });
    
    // Show/hide error message
    const errorElement = document.querySelector(".galleryError");
    if (errorElement) {
      errorElement.style.display = filteredProjects.length === 0 ? "block" : "none";
    }
  }

  renderSuggestions = function (items) {
    let target = document.querySelector(".searchSuggestions");
    if (!target) return;
    target.innerHTML = "";

    if(items.length == 0){
      target.innerHTML = "No Results Found";
    }
    items.forEach(item => {
      target.innerHTML += `<div class='searchPill'>${item}</div>`;
    })
    Array.from(document.querySelectorAll(".searchSuggestions > .searchPill")).forEach(elem => {
      elem.onclick = () => {executeSearch(elem.innerHTML)};
    })
  };

});