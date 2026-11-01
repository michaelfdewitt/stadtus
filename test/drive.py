#!/usr/bin/env python3
"""Interaction smoke test: drives the app in headless Chrome over the DevTools
protocol (no dependencies beyond the standard library).

    python3 -m http.server 8765 &
    python3 test/drive.py [http://localhost:8765/?data=data/bugs.json]

Loads the city, then exercises WASD/QE, orbit drag, wheel zoom, hover, click
selection, double-click zoom, Esc, and reports console errors.
"""
import base64, json, os, socket, struct, subprocess, sys, tempfile, time, urllib.request

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PORT = 9333
URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8765/?data=data/bugs.json"
W, H = 1400, 900


class WS:
    """Minimal WebSocket client (text frames only)."""
    def __init__(self, url):
        host, rest = url[5:].split("/", 1)
        h, p = host.split(":")
        self.s = socket.create_connection((h, int(p)))
        key = base64.b64encode(os.urandom(16)).decode()
        self.s.send((f"GET /{rest} HTTP/1.1\r\nHost: {host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                     f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            buf += self.s.recv(4096)
        self.buf = buf.split(b"\r\n\r\n", 1)[1]
        self.id = 0
        self.events = []

    def _recv_exact(self, n):
        while len(self.buf) < n:
            chunk = self.s.recv(65536)
            if not chunk:
                raise ConnectionError("socket closed")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def recv(self):
        payload = b""
        while True:
            b1, b2 = self._recv_exact(2)
            fin, ln = b1 & 0x80, b2 & 0x7F
            if ln == 126:
                ln = struct.unpack(">H", self._recv_exact(2))[0]
            elif ln == 127:
                ln = struct.unpack(">Q", self._recv_exact(8))[0]
            payload += self._recv_exact(ln)
            if fin:
                return json.loads(payload.decode())

    def send(self, method, **params):
        self.id += 1
        data = json.dumps({"id": self.id, "method": method, "params": params}).encode()
        mask = os.urandom(4)
        head = bytes([0x81])
        n = len(data)
        head += bytes([0x80 | n]) if n < 126 else (bytes([0x80 | 126]) + struct.pack(">H", n) if n < 65536 else bytes([0x80 | 127]) + struct.pack(">Q", n))
        self.s.send(head + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))
        while True:
            msg = self.recv()
            if msg.get("id") == self.id:
                if "error" in msg:
                    raise RuntimeError(msg["error"])
                return msg.get("result", {})
            self.events.append(msg)

    def drain(self, seconds):
        self.s.settimeout(seconds)
        try:
            while True:
                self.events.append(self.recv())
        except (socket.timeout, TimeoutError):
            pass
        finally:
            self.s.settimeout(None)


def main():
    profile = tempfile.mkdtemp(prefix="stadtus-drive-")
    chrome = subprocess.Popen([CHROME, "--headless=new", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-first-run",
                               f"--remote-debugging-port={PORT}", f"--user-data-dir={profile}", f"--window-size={W},{H}", "about:blank"],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(50):
            try:
                targets = json.load(urllib.request.urlopen(f"http://localhost:{PORT}/json"))
                page = next(t for t in targets if t["type"] == "page")
                break
            except Exception:
                time.sleep(0.2)
        ws = WS(page["webSocketDebuggerUrl"])
        ws.send("Runtime.enable"); ws.send("Log.enable"); ws.send("Page.enable")
        ws.send("Page.navigate", url=URL)
        ev = lambda js: ws.send("Runtime.evaluate", expression=js, returnByValue=True, awaitPromise=True).get("result", {}).get("value")
        for _ in range(100):
            if ev("!!(window.stadtus && window.stadtus.city && window.stadtus.layout)"):
                break
            time.sleep(0.3)
        else:
            raise SystemExit("city never loaded")
        time.sleep(1.5)  # let the first frames render
        failures = []

        def check(name, ok, detail=""):
            print(("ok   " if ok else "FAIL ") + name + (f"  {detail}" if detail else ""))
            if not ok:
                failures.append(name)

        cam = lambda: ev("(c => [c.position.x, c.position.y, c.position.z].map(v => +v.toFixed(2)))(stadtus.renderer.camera)")
        target = lambda: ev("(t => [t.x, t.y, t.z].map(v => +v.toFixed(2)))(stadtus.renderer.controls.target)")
        moved = lambda a, b: sum((x - y) ** 2 for x, y in zip(a, b)) ** 0.5

        def key(code, k, vk, hold=0.8):
            ws.send("Input.dispatchKeyEvent", type="keyDown", code=code, key=k, windowsVirtualKeyCode=vk)
            time.sleep(hold)
            ws.send("Input.dispatchKeyEvent", type="keyUp", code=code, key=k, windowsVirtualKeyCode=vk)
            time.sleep(0.15)

        print("items:", ev("stadtus.city.items.length"), "camera:", cam())

        # WASD / QE
        for code, k, vk, axis in [("KeyW", "w", 87, "forward"), ("KeyD", "d", 68, "right"), ("KeyE", "e", 69, "up"), ("KeyQ", "q", 81, "down")]:
            before = cam(); key(code, k, vk); after = cam()
            check(f"key {k} moves camera ({axis})", moved(before, after) > 1, f"{before} -> {after}")
        # E must raise, Q must lower
        before = cam(); key("KeyE", "e", 69); check("E raises camera", cam()[1] > before[1])
        before = cam(); key("KeyQ", "q", 81); check("Q lowers camera", cam()[1] < before[1])

        # orbit drag
        cx, cy = W // 2 - 150, H // 2
        before = cam()
        ws.send("Input.dispatchMouseEvent", type="mousePressed", x=cx, y=cy, button="left", clickCount=1)
        for i in range(1, 11):
            ws.send("Input.dispatchMouseEvent", type="mouseMoved", x=cx + i * 12, y=cy, button="left", buttons=1)
            time.sleep(0.03)
        ws.send("Input.dispatchMouseEvent", type="mouseReleased", x=cx + 120, y=cy, button="left", clickCount=1)
        time.sleep(0.6)
        check("drag orbits camera", moved(before, cam()) > 1, f"{before} -> {cam()}")

        # wheel zoom
        before = cam(); t0 = target()
        ws.send("Input.dispatchMouseEvent", type="mouseWheel", x=cx, y=cy, deltaX=0, deltaY=-600)
        time.sleep(0.8)
        check("wheel zooms", moved(before, cam()) > 1, f"{before} -> {cam()}")

        # reset view, then hover + click a building
        key("KeyR", "r", 82, hold=0.05); time.sleep(1.2)
        # zoom to the tallest building, then aim at its middle
        best = ev("(() => { const r = stadtus.renderer; let b = 0; for (let i = 0; i < r.heights.length; i++) if (r.heights[i] > r.heights[b]) b = i; r.focusBuilding(b); return b; })()")
        time.sleep(1.3)
        pos = ev(f"""(() => {{ const r = stadtus.renderer, b = r.layout.buildings[{best}];
            const v = new (r.camera.position.constructor)(b.x, (b.depth + 1) * 0.35 + r.heights[{best}] * 0.5, b.z).project(r.camera);
            const el = r.renderer.domElement.getBoundingClientRect();
            return {{ i: {best}, x: el.left + (v.x + 1) / 2 * el.width, y: el.top + (1 - v.y) / 2 * el.height }}; }})()""")
        ws.send("Input.dispatchMouseEvent", type="mouseMoved", x=pos["x"], y=pos["y"])
        time.sleep(0.5)
        hit = ev("stadtus.renderer.hit && stadtus.renderer.hit.type")
        check("hover hits a building", hit == "building", f"hit={hit} at {pos}")
        tip = ev("document.getElementById('tooltip').style.display")
        check("tooltip shown on hover", tip == "block", tip)
        ws.send("Input.dispatchMouseEvent", type="mousePressed", x=pos["x"], y=pos["y"], button="left", clickCount=1)
        ws.send("Input.dispatchMouseEvent", type="mouseReleased", x=pos["x"], y=pos["y"], button="left", clickCount=1)
        time.sleep(0.4)
        check("click selects", ev("stadtus.selection.size") == 1, str(ev("stadtus.selection.size")))
        check("inspector shows item", ev("!!document.querySelector('#sidebar table.detail')"))
        acts = ev("Array.from(document.querySelectorAll('#sidebar .actions .btn, #sidebar .actions select')).length")
        check("actions offered for selection", acts > 0, f"{acts} controls")

        # legend click filters; Esc clears
        ws.send("Runtime.evaluate", expression="document.querySelector('#sidebar .legend-row').click()")
        time.sleep(0.4)
        check("legend click filters", ev("stadtus.filters.size") == 1 and ev("stadtus.visibleCount < stadtus.city.items.length"), f"visible {ev('stadtus.visibleCount')}")
        key("Escape", "Escape", 27, hold=0.05); time.sleep(0.4)
        check("Esc clears filters and selection", ev("stadtus.filters.size === 0 && stadtus.selection.size === 0 && stadtus.visibleCount === stadtus.city.items.length"))

        # double-click a district plate zooms in (focus path set)
        before = cam()
        ws.send("Runtime.evaluate", expression="stadtus.focusNode([stadtus.city.tree.children.keys().next().value])")
        time.sleep(1.2)
        check("focus district moves camera + breadcrumb", moved(before, cam()) > 1 and ev("stadtus.focusPath.length") == 1)

        ws.drain(0.5)
        errors = [e for e in ws.events if e.get("method") in ("Runtime.exceptionThrown",) or (e.get("method") == "Log.entryAdded" and e["params"]["entry"]["level"] == "error")]
        for e in errors:
            print("  console:", json.dumps(e["params"])[:300])
        check("no console errors", not errors, f"{len(errors)} errors")

        shot = ws.send("Page.captureScreenshot", format="png")
        out = os.path.join(tempfile.gettempdir(), "stadtus-drive.png")
        open(out, "wb").write(base64.b64decode(shot["data"]))
        print("screenshot:", out)
        print("DRIVE OK" if not failures else f"DRIVE FAILED: {failures}")
        return 0 if not failures else 1
    finally:
        chrome.terminate()


if __name__ == "__main__":
    sys.exit(main())
