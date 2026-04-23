// The Fallback - Configuration
// This file contains API keys and other configuration settings
// Keep this file separate from index.html for easier updates

const CONFIG = {
  // Geocod.io API Key - for address geocoding
  // Get yours at: https://www.geocod.io/
  GEOCODIO_KEY: '9019b6c968e5677bc69e0b796e8b0618c6149bb',
  
  // OpenRouteService API Key - for driving directions and distances
  // Get yours at: https://openrouteservice.org/ (free, 2000 requests/day)
  ORS_API_KEY: 'eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6IjZjNzVhMGIyZTg4NDQ1OTQ5M2FiYmE2MTZmNWFkMGEyIiwiaCI6Im11cm11cjY0In0=',

  // Mapbox Access Token - for place autocomplete (Foursquare + Mapbox POI data)
  // Used as a 3rd-tier fallback when Photon + Nominatim (OSM) return sparse results.
  // Get yours at: https://account.mapbox.com/access-tokens/ (free, 100k requests/month)
  // Public tokens start with "pk."
  MAPBOX_TOKEN: 'YOUR_MAPBOX_PUBLIC_TOKEN',

  // Anthropic API Key - for AI suggestions
  // Get yours at: https://console.anthropic.com/
  ANTHROPIC_KEY: 'YOUR_ANTHROPIC_API_KEY'
};
