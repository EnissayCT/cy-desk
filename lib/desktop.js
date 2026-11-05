// Pins a window to the desktop layer: owned by the window that hosts the desktop
// icons (Progman, or the WorkerW holding SHELLDLL_DefView), kept at the bottom of
// the z-order, so it stays visible on "Show desktop" (Win+D) and never covers apps.
const koffi = require('koffi');

const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');

const FindWindowW = user32.func('intptr_t __stdcall FindWindowW(const char16_t *cls, const char16_t *name)');
const FindWindowExW = user32.func('intptr_t __stdcall FindWindowExW(intptr_t parent, intptr_t after, const char16_t *cls, const char16_t *name)');
const SetWindowLongPtrW = user32.func('intptr_t __stdcall SetWindowLongPtrW(intptr_t hwnd, int index, intptr_t value)');
const SetWindowPos = user32.func('bool __stdcall SetWindowPos(intptr_t hwnd, intptr_t after, int x, int y, int cx, int cy, uint32_t flags)');
const IsWindow = user32.func('bool __stdcall IsWindow(intptr_t hwnd)');
const ReadMem = kernel32.func('void __stdcall RtlMoveMemory(_Out_ uint8_t *dst, intptr_t src, size_t n)');
const WriteMem = kernel32.func('RtlMoveMemory', 'void', ['intptr_t', 'uint8_t *', 'size_t']);

const GWLP_HWNDPARENT = -8;
const HWND_BOTTOM = 1;
const SWP_NOSIZE = 0x1, SWP_NOMOVE = 0x2, SWP_NOZORDER = 0x4, SWP_NOACTIVATE = 0x10;
const WM_WINDOWPOSCHANGING = 0x46;
const WINDOWPOS_FLAGS_OFFSET = 32; // x64: hwnd(8) hwndInsertAfter(8) x y cx cy (4 each) flags

function desktopHost() {
  const progman = FindWindowW('Progman', null);
  if (progman && FindWindowExW(progman, 0, 'SHELLDLL_DefView', null)) return progman;
  let w = 0;
  while ((w = FindWindowExW(0, w, 'WorkerW', null))) {
    if (FindWindowExW(w, 0, 'SHELLDLL_DefView', null)) return w;
  }
  return progman || 0;
}

function hwndOf(win) {
  return Number(win.getNativeWindowHandle().readBigUInt64LE(0));
}

function pin(win) {
  const hwnd = hwndOf(win);
  const host = desktopHost();
  if (!host) return false;
  SetWindowLongPtrW(hwnd, GWLP_HWNDPARENT, host);
  win.__cyAllowZ = true;
  SetWindowPos(hwnd, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
  win.__cyAllowZ = false;
  if (!win.__cyHooked) {
    win.__cyHooked = true;
    // Refuse every z-order change (clicks, focus, Alt+Tab) so the window stays under apps.
    win.hookWindowMessage(WM_WINDOWPOSCHANGING, (_wParam, lParam) => {
      if (win.__cyAllowZ) return;
      const addr = Number(lParam.readBigUInt64LE(0));
      if (!addr) return;
      const buf = Buffer.alloc(4);
      ReadMem(buf, addr + WINDOWPOS_FLAGS_OFFSET, 4);
      const flags = buf.readUInt32LE(0);
      if (!(flags & SWP_NOZORDER)) {
        buf.writeUInt32LE(flags | SWP_NOZORDER, 0);
        WriteMem(addr + WINDOWPOS_FLAGS_OFFSET, buf, 4);
      }
    });
  }
  win.__cyHost = host;
  return true;
}

const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(intptr_t hwnd)');
const SendMessageW = user32.func('intptr_t __stdcall SendMessageW(intptr_t hwnd, uint32_t msg, uintptr_t wParam, intptr_t lParam)');
const WM_COMMAND = 0x111, TOGGLE_DESKTOP_ICONS = 0x7402;

function iconView() {
  const host = desktopHost();
  const defView = host && FindWindowExW(host, 0, 'SHELLDLL_DefView', null);
  const list = defView && FindWindowExW(defView, 0, 'SysListView32', null);
  return { defView, list };
}

// Same switch as right-click desktop > View > Show desktop icons.
function iconsVisible() {
  const { list } = iconView();
  return !!list && IsWindowVisible(list);
}
function setIcons(visible) {
  const { defView } = iconView();
  if (defView && iconsVisible() !== visible) SendMessageW(defView, WM_COMMAND, TOGGLE_DESKTOP_ICONS, 0);
}

const RECT = koffi.struct('RECT', { left: 'int', top: 'int', right: 'int', bottom: 'int' });
const GetForegroundWindow = user32.func('intptr_t __stdcall GetForegroundWindow()');
const GetWindowRect = user32.func('bool __stdcall GetWindowRect(intptr_t hwnd, _Out_ RECT *rect)');
const IsIconic = user32.func('bool __stdcall IsIconic(intptr_t hwnd)');
const GetClassNameW = user32.func('int __stdcall GetClassNameW(intptr_t hwnd, _Out_ uint8_t *name, int max)');

// True when the foreground app covers the whole dashboard (maximized or fullscreen):
// nothing of it can be seen, so animations can stop.
function covered(win) {
  const fg = GetForegroundWindow();
  const me = hwndOf(win);
  if (!fg || fg === me || fg === win.__cyHost || IsIconic(fg)) return false;
  // Show desktop (Win+D) brings the desktop's own windows forward: that is the dashboard showing, not covered.
  const cls = Buffer.alloc(128);
  const n = GetClassNameW(fg, cls, 64);
  if (['Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd'].includes(cls.toString('utf16le', 0, n * 2))) return false;
  const a = {}, b = {};
  if (!GetWindowRect(fg, a) || !GetWindowRect(me, b)) return false;
  return a.left <= b.left + 2 && a.top <= b.top + 2 && a.right >= b.right - 2 && a.bottom >= b.bottom - 2;
}

function hostAlive(win) {
  return !!win.__cyHost && IsWindow(win.__cyHost);
}

module.exports = { pin, hostAlive, desktopHost, iconsVisible, setIcons, covered };
