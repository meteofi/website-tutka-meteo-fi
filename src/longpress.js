/**
 * Creates a long-press handler for a button that shows a context menu.
 * Short tap (< 500ms) calls onTap. Long press (>= 500ms) shows the menu.
 *
 * Multiple handlers may share one menu (e.g. the same radar sublayer menu
 * opened from the global toolbar AND from each split pane's mini pill). To
 * avoid double-firing, the menu items are wired exactly once per menu; each
 * handler installs its own `onSelect` as the menu's *current* select callback
 * when it opens. Since only one menu is open at a time, the last opener wins.
 *
 * @param {string|HTMLElement} button - the trigger button (DOM id or element)
 * @param {string} menuId - DOM id of the context menu
 * @param {Function} onTap - called on short tap
 * @param {Function} onSelect - called with the selected menu item's data-layer value
 * @param {Function} getActiveLayer - returns the current active WMS layer name for highlighting
 * @param {Function} isLayerVisible - returns whether the layer is currently visible
 * @param {Function} [onMenuShown] - called whenever the long-press menu opens
 * @returns {{ show: Function, hide: Function }}
 */
// Per-menu state, kept off the DOM. A shared sublayer menu may be driven by
// several handlers (the global toolbar in 1-up, every pane pill in split); only
// one is open at a time, so we track its current select callback + opener here.
const menuState = new WeakMap(); // menuEl -> { onSelect, opener }
const wiredMenus = new WeakSet(); // menus whose items are already wired

// Which button currently owns a menu (set on open). The outside-click closer in
// radar.js uses this so releasing the opener after a long press doesn't dismiss
// the menu it just opened.
export function longPressMenuOpener(menuEl) {
  const state = menuEl && menuState.get(menuEl);
  return (state && state.opener) || null;
}

function createLongPressHandler(button, menuId, onTap, onSelect, getActiveLayer, isLayerVisible, onMenuShown) {
  let timer = null;
  let triggered = false;
  let startTime = 0;
  const buttonEl = typeof button === 'string' ? document.getElementById(button) : button;

  function showMenu() {
    const menu = document.getElementById(menuId);
    // Install this handler's select callback + opener as the menu's current
    // state, so a pick routes back to the button/pane that opened it and the
    // outside-click closer doesn't dismiss the menu when this very button is
    // released after the long press.
    menuState.set(menu, { onSelect, opener: buttonEl });
    const menuItems = menu.querySelectorAll('.menu-item');
    const currentLayer = getActiveLayer();
    const visible = isLayerVisible();
    menuItems.forEach((item) => {
      item.classList.toggle('selected', visible && item.getAttribute('data-layer') === currentLayer);
    });

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const br = buttonEl.getBoundingClientRect();
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
    if (onMenuShown) onMenuShown();
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

  buttonEl.addEventListener('mousedown', start);
  buttonEl.addEventListener('mouseup', end);
  buttonEl.addEventListener('mouseleave', cancel);
  buttonEl.addEventListener('touchstart', (e) => { e.preventDefault(); start(e); });
  buttonEl.addEventListener('touchend', (e) => { e.preventDefault(); end(e); });
  buttonEl.addEventListener('touchmove', (e) => { e.preventDefault(); cancel(); });
  buttonEl.addEventListener('touchcancel', (e) => { e.preventDefault(); cancel(); });

  // Wire the menu items exactly once per menu — subsequent handlers reuse the
  // same wiring via the menu's current state.
  const menu = document.getElementById(menuId);
  if (menu && !wiredMenus.has(menu)) {
    wiredMenus.add(menu);
    menu.querySelectorAll('.menu-item').forEach((item) => {
      const pick = (e) => {
        if (e) { e.preventDefault(); e.stopPropagation(); }
        const state = menuState.get(menu);
        if (state && state.onSelect) state.onSelect(item.getAttribute('data-layer'));
      };
      item.addEventListener('click', pick);
      item.addEventListener('touchend', pick);
    });
  }

  return { show: showMenu, hide: hideMenu };
}

export default createLongPressHandler;
