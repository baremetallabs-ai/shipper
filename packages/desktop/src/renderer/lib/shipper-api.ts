import type { ShipperApi } from '../types.js';

export function getShipperApi(): ShipperApi {
  const shipperWindow = window as { shipperAPI?: ShipperApi };
  if (!shipperWindow.shipperAPI) {
    throw new Error('window.shipperAPI is not available');
  }

  return shipperWindow.shipperAPI;
}
