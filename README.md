# Cykes

A free, simple map of hiking trails in Cyprus. No account, no ads, no backend.

- Map of Cyprus with every hiking route in OpenStreetMap: Troodos nature trails, Akamas, the E4 and local paths
- Filter by region, difficulty and length, or search by name
- Each trail shows length, total climb, highest point, an elevation profile, rough walking time and difficulty
- Download the trail as GPX, get driving directions to the start, share a link to a trail
- Works on phones

## How it works

It is a static site (HTML, CSS, plain JavaScript and [Leaflet](https://leafletjs.com)), hosted free on GitHub Pages.

A GitHub Action (`.github/workflows/deploy.yml`) runs on every push to `main` and every Monday. It:

1. Downloads all `route=hiking` / `route=foot` relations in Cyprus, plus named trail paths, from the OpenStreetMap [Overpass API](https://overpass-api.de).
2. Joins the pieces of each route, simplifies them, works out length, region, loop/one-way and difficulty.
3. Looks up elevation along each trail from SRTM 30 m data via [Open Topo Data](https://www.opentopodata.org) (skipped if the service is down).
4. Writes `data/trails.geojson` and publishes the site to GitHub Pages.

If OpenStreetMap is unreachable the build fails and the previously published site stays up.

Difficulty uses the OpenStreetMap `sac_scale` or `difficulty` tag when mappers set it. Otherwise it is estimated from length and climbing, and the app labels it "estimated".

## Run it locally

```sh
node scripts/build-data.mjs        # needs Node 18+, writes data/trails.geojson
python3 -m http.server 8000        # then open http://localhost:8000
```

`--no-elevation` skips the elevation lookup; `--input file.json` builds from a saved Overpass response.

## Credits and licences

- Trail data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), Open Database License (ODbL). Wrong or missing trail? Fix it on OpenStreetMap and it will appear here after the next weekly refresh.
- Map tiles: OpenStreetMap and [OpenTopoMap](https://opentopomap.org) (CC-BY-SA).
- Elevation: NASA SRTM via Open Topo Data.
- [Leaflet](https://leafletjs.com) 1.9.4 (BSD-2-Clause), included in `vendor/leaflet`.
