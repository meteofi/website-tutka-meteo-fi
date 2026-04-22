/**
 * Creates a long-press handler for a button that shows a context menu.
 * Short tap (< 500ms) calls onTap. Long press (>= 500ms) shows the menu.
 *
 * @param {string} buttonId - DOM id of the trigger button
 * @param {string} menuId - DOM id of the context menu
 * @param {Function} onTap - called on short tap
 * @param {Function} onSelect - called with the selected menu item's data-layer value
 * @param {Function} getActiveLayer - returns the current active WMS layer name for highlighting
 * @param {Function} isLayerVisible - returns whether the layer is currently visible
 * @returns {{ show: Function, hide: Function }}
 */
function createLongPressHandler(buttonId, menuId, onTap, onSelect, getActiveLayer, isLayerVisible) {
  let timer = null;
  let triggered = false;
  let startTime = 0;
  const button = document.getElementById(buttonId);

  function showMenu() {
    const menu = document.getElementById(menuId);
    const menuItems = menu.querySelectorAll('.menu-item');
    const currentLayer = getActiveLayer();
    const visible = isLayerVisible();
    menuItems.forEach((item) => {
      item.classList.toggle('selected', visible && item.getAttribute('data-layer') === currentLayer);
    });

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const br = button.getBoundingClientRect();
    menu.style.display = 'block';
    menu.style.visibility = 'hidden';
    const mr = menu.getBoundingClientRect();
    const left = Math.max(10, Math.min(br.left, vw - mr.width - 10));
    let top = br.bottom + 5;
    if (top + mr.height > vh - 10) {
      top = Math.max(10, br.top - mr.height - 5);
    }
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.style.visibility = 'visible';
  }

  function hideMenu() {
    document.getElementById(menuId).style.display = 'none';
  }

  function start() {
    triggered = false;
    startTime = Date.now();
    timer = setTimeout(() => {
      triggered = true;
      showMenu();
    }, 500);
  }

  function end() {
    clearTimeout(timer);
    if (!triggered && Date.now() - startTime < 500) {
      onTap();
    }
  }

  function cancel() {
    clearTimeout(timer);
    triggered = false;
  }

  button.addEventListener('mousedown', start);
  button.addEventListener('mouseup', end);
  button.addEventListener('mouseleave', cancel);
  button.addEventListener('touchstart', (e) => { e.preventDefault(); start(e); });
  button.addEventListener('touchend', (e) => { e.preventDefault(); end(e); });
  button.addEventListener('touchmove', (e) => { e.preventDefault(); cancel(); });
  button.addEventListener('touchcancel', (e) => { e.preventDefault(); cancel(); });

  // Menu item click/touch handlers
  document.querySelectorAll(`#${menuId} .menu-item`).forEach((item) => {
    item.addEventListener('click', function () {
      onSelect(this.getAttribute('data-layer'));
    });
    item.addEventListener('touchend', function (e) {
      e.preventDefault();
      e.stopPropagation();
      onSelect(this.getAttribute('data-layer'));
    });
  });

  return { show: showMenu, hide: hideMenu };
}

export default createLongPressHandler;
