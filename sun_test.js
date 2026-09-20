function getSunElevation(date, lat, lon) {
    const rad = Math.PI / 180;
    const d = (date.getTime() / 86400000) - (10957.5);
    const g = (357.529 + 0.98560028 * d) % 360;
    const q = (280.459 + 0.98564736 * d) % 360;
    const L = (q + 1.915 * Math.sin(g * rad) + 0.020 * Math.sin(2 * g * rad)) % 360;
    const e = 23.439 - 0.00000036 * d;
    const dec = Math.asin(Math.sin(e * rad) * Math.sin(L * rad));
    let ra = Math.atan2(Math.cos(e * rad) * Math.sin(L * rad), Math.cos(L * rad));
    const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
    const lha = (gmst * 15 + lon) * rad - ra;
    const el = Math.asin(Math.sin(lat * rad) * Math.sin(dec) + Math.cos(lat * rad) * Math.cos(dec) * Math.cos(lha));
    return el / rad;
}
const d1 = new Date("2026-09-20T12:00:00+02:00"); // Noon in Leipzig
const d2 = new Date("2026-09-20T00:00:00+02:00"); // Midnight in Leipzig
console.log("Noon:", getSunElevation(d1, 51.3, 12.3));
console.log("Midnight:", getSunElevation(d2, 51.3, 12.3));
