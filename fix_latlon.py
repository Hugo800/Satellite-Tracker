import re

with open('app.js', 'r') as f:
    content = f.read()

target = """        const posEcf = satellite.eciToEcf(pv.position, gmst);
        const look   = satellite.ecfToLookAngles("""

repl = """        const posEcf = satellite.eciToEcf(pv.position, gmst);
        const posGd  = satellite.eciToGeodetic(pv.position, gmst);
        const look   = satellite.ecfToLookAngles("""

content = content.replace(target, repl)

target2 = """          vel:     vel,  // km/s
          visible: elDeg >= CONFIG.VISIBLE_EL_MIN,"""

repl2 = """          vel:     vel,  // km/s
          lat:     posGd.latitude * 180 / Math.PI,
          lon:     posGd.longitude * 180 / Math.PI,
          visible: elDeg >= CONFIG.VISIBLE_EL_MIN,"""

content = content.replace(target2, repl2)

with open('app.js', 'w') as f:
    f.write(content)
