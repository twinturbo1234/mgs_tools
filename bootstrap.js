
// Standalone bootstrap — runs after the swapper module is defined.
(function(){
  function start(){
    if(typeof openAnimSwapper !== 'function'){
      console.error('openAnimSwapper not defined — build is broken');
      return;
    }
    // Remove splash and open the swapper full-screen
    var splash = document.getElementById('splash');
    if(splash) splash.remove();
    openAnimSwapper();
    // Hide the Close button — in standalone mode there's nothing to close to.
    // The Clear button still works for resetting loaded files.
    var closeBtn = document.getElementById('atClose');
    if(closeBtn) closeBtn.style.display = 'none';
    // Rebrand the title for the standalone build
    var titleEl = document.querySelector('#animSwapperPanel > div:first-child > div:first-child');
    if(titleEl) titleEl.textContent = '🎬 MGS1 Animation Swapper';
  }
  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
