# SPARTAN Agribot dashboard - Socket.IO + mobile

    assets/index.html, style.css, app.js  -> ~/ArduinoApps/demo/assets/
    python/main.py, requirements.txt      -> ~/ArduinoApps/demo/python/   (requirements.txt = psutil)

Keep assets/libs/socket.io.min.js (index.html loads libs/socket.io.min.js).
app.yaml needs the web_ui and dbstorage_tsstore bricks (copy from the System Resources Logger example).

Browser -> board: drive {linear, angular}, estop, arm {joints:[base,shoulder,elbow]}, cnn_predict {source, sample, image}
Board -> browser: telemetry {gps{fix,lat,lon}, rpm[L,R]}, log, cnn_result, cpu_usage, memory_usage
History REST: GET /get_samples/{cpu|mem}/{start}/{window}

Layout: >=1100 px wide and >=640 px tall = fixed 3-column HUD; anything smaller = scrolling page
(1 column on phones, 2 columns on tablets / landscape phones) with sticky header and status bar.