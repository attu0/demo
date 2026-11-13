import time
import threading
import random

from arduino.app_utils import App
from arduino.app_bricks.web_ui import WebUI

# Bridge talks to the sketch on the MCU. If it is missing or the sketch does not
# provide these functions yet, calls are logged and skipped instead of crashing.
try:
    from arduino.app_utils import Bridge
except Exception:
    Bridge = None

web_ui = WebUI()

WATCHDOG_S = 0.5          # stop rover if no "drive" for this long
SPRAY_MAX_LINEAR = 0.05   # only spray while (almost) stationary
MAX_SPRAY_MS = 5000

state = {
    "linear": 0.0,        # -1..1, + forward
    "angular": 0.0,       # -1..1, + left
    "last_cmd": 0.0,
    "arm": [90, 115, 75], # base, shoulder, elbow (deg)
    "spraying": False,
}
lock = threading.Lock()


# ---------------- MCU helpers ----------------
def mcu(fn, *args):
    """Call a function provided by the sketch (Bridge.provide on the MCU side)."""
    if Bridge is None:
        return
    try:
        Bridge.call(fn, *args)
    except Exception as e:
        log(f"MCU '{fn}' failed: {e}")


def log(msg):
    print(msg, flush=True)
    web_ui.send_message("log", msg)


def wheel_speeds(linear, angular):
    """Differential drive mix -> (left, right) in -1..1."""
    left = max(-1.0, min(1.0, linear - angular * 0.7))
    right = max(-1.0, min(1.0, linear + angular * 0.7))
    return left, right


def apply_drive():
    left, right = wheel_speeds(state["linear"], state["angular"])
    mcu("drive", left, right)          # sketch: drive(float left, float right)


def stop_motors():
    state["linear"] = state["angular"] = 0.0
    mcu("drive", 0.0, 0.0)


# ---------------- Socket handlers ----------------
def on_drive(sid, data):
    with lock:
        state["linear"] = max(-1.0, min(1.0, float(data.get("linear", 0))))
        state["angular"] = max(-1.0, min(1.0, float(data.get("angular", 0))))
        state["last_cmd"] = time.time()
        apply_drive()


def on_estop(sid, data):
    with lock:
        stop_motors()
    set_pump(False)
    log("E-STOP")


def on_arm(sid, data):
    joints = data.get("joints", [])
    if len(joints) != 3:
        return
    base, shoulder, elbow = (int(j) for j in joints)
    # Clamp to the same limits the UI sliders use
    base = max(0, min(180, base))
    shoulder = max(25, min(160, shoulder))
    elbow = max(20, min(160, elbow))
    state["arm"] = [base, shoulder, elbow]
    mcu("arm", base, shoulder, elbow)  # sketch: arm(int base, int shoulder, int elbow)


def set_pump(on):
    state["spraying"] = on
    mcu("pump", 1 if on else 0)        # sketch: pump(int on)


def spray_for(ms):
    ms = min(int(ms), MAX_SPRAY_MS)
    if ms <= 0:
        return
    if abs(state["linear"]) > SPRAY_MAX_LINEAR:
        log("Spray skipped: rover is moving")
        return

    def run():
        set_pump(True)
        log(f"Pump ON for {ms} ms")
        t_end = time.time() + ms / 1000
        while time.time() < t_end:
            if not state["spraying"]:           # cancelled by E-STOP
                return
            if abs(state["linear"]) > SPRAY_MAX_LINEAR:
                log("Pump OFF: rover started moving")
                break
            time.sleep(0.05)
        set_pump(False)

    threading.Thread(target=run, daemon=True).start()


# ---------------- Leaf inference ----------------
CLASSES = {
    "early_blight":   {"title": "Early Blight",    "spray_ms": 2500},
    "powdery_mildew": {"title": "Powdery Mildew",  "spray_ms": 2200},
    "healthy":        {"title": "Healthy",         "spray_ms": 0},
}
_demo_idx = 0


def run_inference(source, image_b64, sample_hint=None):
    """
    TODO: replace with the real CNN.
      source      : "arm_camera" | "upload"
      image_b64   : data-URL JPEG (224x224) for "upload", None for "arm_camera"
                    (grab the frame from the board camera yourself in that case)
      sample_hint : the Blight/Mildew/Healthy button selected in the UI. Demo only:
                    the stub honours it, a real model must ignore it.
    Return probabilities in this order: early blight, late blight, powdery mildew, healthy.
    This stub cycles through demo results so the whole pipeline can be tested.
    """
    global _demo_idx
    if sample_hint in CLASSES:
        key = sample_hint
    else:
        key = list(CLASSES)[_demo_idx % len(CLASSES)]
        _demo_idx += 1
    top = round(random.uniform(90, 98), 1)
    rest = round(100 - top, 1)
    probs = {"eb": 0.0, "lb": 0.0, "pm": 0.0, "hl": 0.0}
    top_key = {"early_blight": "eb", "powdery_mildew": "pm", "healthy": "hl"}[key]
    others = [k for k in probs if k != top_key]
    split = [round(rest * w, 1) for w in (0.5, 0.3, 0.2)]
    probs[top_key] = top
    for k, v in zip(others, split):
        probs[k] = v
    time.sleep(0.8)   # fake model latency
    return key, top, probs


def on_cnn_predict(sid, data):
    def work():
        key, conf, probs = run_inference(
            data.get("source", "arm_camera"), data.get("image"), data.get("sample"))
        info = CLASSES[key]
        web_ui.send_message("cnn_result", {
            "sample": key,
            "title": info["title"],
            "conf": conf,
            "probs": probs,
            "sprayMs": info["spray_ms"],
        })
        log(f"CNN: {info['title']} {conf}%")
        if info["spray_ms"] > 0:
            spray_for(info["spray_ms"])

    threading.Thread(target=work, daemon=True).start()


for name, fn in [("drive", on_drive), ("estop", on_estop), ("arm", on_arm),
                 ("cnn_predict", on_cnn_predict)]:
    web_ui.on_message(name, fn)


# ---------------- System stats (Linux side of the UNO Q) ----------------
_last_cpu = None


def cpu_percent():
    global _last_cpu
    try:
        with open("/proc/stat") as f:
            vals = [int(x) for x in f.readline().split()[1:]]
        idle, total = vals[3] + vals[4], sum(vals)
        prev, _last_cpu = _last_cpu, (idle, total)
        if prev is None or total == prev[1]:
            return 0.0
        return 100.0 * (1 - (idle - prev[0]) / (total - prev[1]))
    except Exception:
        return None


def ram_text():
    try:
        info = {}
        with open("/proc/meminfo") as f:
            for line in f:
                k, v = line.split(":")
                info[k] = int(v.split()[0])       # kB
        used = (info["MemTotal"] - info["MemAvailable"]) / 1048576
        return f"{used:.2f}/{info['MemTotal'] / 1048576:.2f} GB"
    except Exception:
        return None


def read_gps():
    """TODO: read the NEO-6M (serial/NMEA or via the sketch).
    Return {"fix": True, "lat": ..., "lon": ...} when you have a fix."""
    return {"fix": False}


# ---------------- Telemetry + watchdog ----------------
def telemetry_loop():
    while True:
        with lock:
            # Safety: stop if the browser stops sending commands
            if (state["linear"] or state["angular"]) and time.time() - state["last_cmd"] > WATCHDOG_S:
                stop_motors()
                log("Watchdog: no commands, motors stopped")
            left, right = wheel_speeds(state["linear"], state["angular"])
        web_ui.send_message("telemetry", {
            "battery": 87,                    # TODO: real reading
            "heading": 0,                     # TODO: IMU / compass
            "gps": read_gps(),
            "cpu": cpu_percent(),
            "ram": ram_text(),
            "rpm": [round(left * 130), round(right * 130)],   # estimate from command
            "spraying": state["spraying"],
        })
        time.sleep(0.5)


threading.Thread(target=telemetry_loop, daemon=True).start()
App.run()