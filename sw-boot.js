// Register the service worker in production only. On localhost we skip it (and
// unregister any existing one) so code edits always show up on reload.
(function () {
  if (!("serviceWorker" in navigator)) return;
  var host = location.hostname;
  var isLocal = host === "localhost" || host === "127.0.0.1" || host === "";
  if (isLocal) {
    navigator.serviceWorker.getRegistrations().then(function (regs) {
      regs.forEach(function (r) { r.unregister(); });
    });
    return;
  }

  var banner = document.getElementById("update-banner");
  var reloadBtn = document.getElementById("update-reload");
  var registration = null;
  var refreshing = false;
  var clicked = false;

  function doReload() {
    if (refreshing) return;
    refreshing = true;
    hideUpdate();
    window.location.reload();
  }

  navigator.serviceWorker.addEventListener("controllerchange", doReload);

  function showUpdate() {
    if (!navigator.serviceWorker.controller) return;
    if (clicked) return;
    if (banner) banner.classList.remove("hidden");
  }

  function hideUpdate() {
    if (banner) banner.classList.add("hidden");
  }

  function trackWorker(worker) {
    if (!worker) return;
    if (worker.state === "installed") { showUpdate(); return; }
    worker.addEventListener("statechange", function () {
      if (worker.state === "installed") showUpdate();
    });
  }

  function activateUpdate() {
    if (clicked) return;
    clicked = true;
    if (reloadBtn) reloadBtn.disabled = true;
    var label = banner && banner.querySelector("span");
    if (label) label.textContent = "Updating…";
    function messageWaiting() {
      var waiting = registration && registration.waiting;
      if (waiting) {
        waiting.addEventListener("statechange", function () {
          if (waiting.state === "activated") doReload();
        });
        waiting.postMessage("SKIP_WAITING");
      }
    }
    messageWaiting();
    if (registration && registration.update) {
      registration.update().then(messageWaiting).catch(function () {});
    }
    setTimeout(doReload, 1500);
  }

  if (reloadBtn) reloadBtn.addEventListener("click", activateUpdate);

  window.addEventListener("load", function () {
    navigator.serviceWorker.register("service-worker.js").then(function (reg) {
      registration = reg;
      if (reg.waiting) showUpdate();
      if (reg.installing) trackWorker(reg.installing);
      reg.addEventListener("updatefound", function () {
        trackWorker(reg.installing);
      });
    });
  });
})();
