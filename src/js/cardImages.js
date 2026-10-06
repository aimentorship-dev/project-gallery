/**
 * Markup for the pictures on a gallery card.
 *
 * The hero used to be a CSS background and the avatars 24px circles painted from
 * 5 MB phone photos - every one of ~200 cards downloaded its originals on load, and a
 * single visit moved ~250 MB. They are real <img> elements now: the browser lazy-loads
 * the ones below the fold and picks a size from the srcset that optimizeImages.js
 * generated at build time.
 *
 * Keep this in step with the server-rendered cards in index.html / published.html -
 * index.js reuses those when the counts match, and any difference shows up as layout
 * shift when the JS re-renders after a filter.
 */
'use strict';

var PLACEHOLDER = '/assets/images/missing_image.png';
// The gallery is a CSS multi-column masonry (index.scss): 1 column below 576px,
// 2 from 576, 3 from 992, 4 from 1200, inside a 1680px max-width container - so
// every card, "expand" or not, is one column wide. Same string in index.html and
// published.html.
var SIZES = '(min-width: 1680px) 400px, (min-width: 1200px) 25vw, (min-width: 992px) 33vw, (min-width: 576px) 50vw, 100vw';

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** The card's picture, layered over the subject gradient; '' when there is none. */
function heroImgTag(project, eager) {
  var h = project && project.hero_img;
  if (!h || !h.src) return '';
  return '<img class="heroImg" src="' + esc(h.src) + '"'
    + (h.srcset ? ' srcset="' + esc(h.srcset) + '" sizes="' + SIZES + '"' : '')
    + (h.w && h.h ? ' width="' + h.w + '" height="' + h.h + '"' : '')
    + ' alt="" loading="' + (eager ? 'eager' : 'lazy') + '" decoding="async"'
    // a hotlink that has rotted just disappears, leaving the gradient tile
    + ' onerror="this.remove()">';
}

/** 24px round avatar; falls back to the placeholder if the file is missing. */
function avatarTag(avatar) {
  var src = (avatar && avatar.src) || PLACEHOLDER;
  return '<img class="profile_image" src="' + esc(src) + '"'
    + (avatar && avatar.srcset ? ' srcset="' + esc(avatar.srcset) + '"' : '')
    + ' width="24" height="24" alt="" loading="lazy" decoding="async"'
    + ' onerror="this.onerror=null;this.src=' + "'" + PLACEHOLDER + "'" + '">';
}

module.exports = { heroImgTag: heroImgTag, avatarTag: avatarTag, PLACEHOLDER: PLACEHOLDER };
