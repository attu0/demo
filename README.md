# SPARTAN (Spartans_.html) - Socket.IO port

    assets/index.html, style.css, app.js  -> ~/ArduinoApps/demo/assets/
    python/main.py, requirements.txt      -> ~/ArduinoApps/demo/python/   (requirements.txt = psutil)

Keep assets/libs/socket.io.min.js (index.html loads libs/socket.io.min.js).

Browser -> board: drive {linear, angular}, estop, arm {joints:[base,shoulder,elbow]},
                  cnn_predict {source, sample, image}
Board -> browser: telemetry {battery, heading, gps{fix,lat,lon}, cpu, ram, rpm[L,R]},
                  log, cnn_result {sample, title, conf, probs{eb,lb,pm,hl}, sprayMs}

Sketch must provide via Bridge: drive(left,right), arm(base,shoulder,elbow), pump(on).

System Resources Logger (footer 'Resources' button): board pushes cpu_usage / memory_usage every ~5 s,
history via GET /get_samples/{cpu|mem}/{start}/{window} (TimeSeriesStore brick, same as the example app).
Charts are drawn on a plain canvas, no Chart.js / CDN needed.