# SPARTAN (Spartans_.html) - Socket.IO port

    assets/index.html, style.css, app.js  -> ~/ArduinoApps/demo/assets/
    python/main.py                        -> ~/ArduinoApps/demo/python/

Keep assets/libs/socket.io.min.js (index.html loads libs/socket.io.min.js).

Browser -> board: drive {linear, angular}, estop, arm {joints:[base,shoulder,elbow]},
                  cnn_predict {source, sample, image}
Board -> browser: telemetry {battery, heading, gps{fix,lat,lon}, cpu, ram, rpm[L,R]},
                  log, cnn_result {sample, title, conf, probs{eb,lb,pm,hl}, sprayMs}

Sketch must provide via Bridge: drive(left,right), arm(base,shoulder,elbow), pump(on).