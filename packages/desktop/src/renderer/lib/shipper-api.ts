import type { ShipperApi } from '../types.js';

export function getShipperApi(): ShipperApi {
  const shipperWindow = window as { shipperAPI: ShipperApi };
  return shipperWindow.shipperAPI;
}
