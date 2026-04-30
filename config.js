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
  MAPBOX_TOKEN: 'pk.eyJ1IjoiamxkdWdnaW5zIiwiYSI6ImNtb2J1ZXM1aDA1YWwycXE0cmJ0ejdlbmEifQ.do9zKp0590jvkb3tEy7X0g',

  // Anthropic API Key - for AI suggestions
  // Get yours at: https://console.anthropic.com/
  ANTHROPIC_KEY: 'YOUR_ANTHROPIC_API_KEY',

  // OpenTripMap API Key — tourist/attraction POIs with popularity ratings,
  // Wikidata/Wikipedia linkage, and preview images.
  // Get yours at: https://opentripmap.io/product
  // Used by Discover for Natural, Cultural, Quirky, Historical, and Top Picks.
  // Camping and Hiking remain on Overpass (OSM amenity tags + trail data).
  OPENTRIPMAP_KEY: '5ae2e3f221c38a28845f05b6d9112cf0ed3b6eb491477e6a147e910c'
};
