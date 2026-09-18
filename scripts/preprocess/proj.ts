import proj4 from 'proj4'

/**
 * EPSG:5179 — Korea 2000 / Unified CS (UTM-K). The projected metre grid most
 * Korean national datasets ship in (SGIS 격자통계, 행정동 경계, 국토지리정보원).
 * Transverse Mercator on GRS80, central meridian 127.5°E, false origin
 * (1 000 000, 2 000 000). Seoul sits around x ≈ 953 000, y ≈ 1 952 000.
 */
export const EPSG_5179 =
  '+proj=tmerc +lat_0=38 +lon_0=127.5 +k=0.9996 +x_0=1000000 +y_0=2000000 +ellps=GRS80 +units=m +no_defs'

const fromUtmK = proj4(EPSG_5179, 'EPSG:4326')

/** EPSG:5179 metres → WGS84 [lng, lat]. */
export function utmKToWgs84(x: number, y: number): [number, number] {
  const [lng, lat] = fromUtmK.forward([x, y])
  return [lng, lat]
}
