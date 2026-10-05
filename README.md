# Geospatial — São Paulo

A São Paulo edition of [jeantimex/geospatial](https://github.com/jeantimex/geospatial): a Three.js scene that renders Google Photorealistic 3D Tiles of the city with physically based atmosphere, volumetric clouds and sun/moon lighting.

## São Paulo Demo

The main page (`index.html` → `src/main/index.ts`) frames the camera over Avenida Paulista / MASP (`-23.5614, -46.6559`) at 9:00 AM São Paulo time (UTC-03:00). It includes:

- Google Photorealistic 3D Tiles of São Paulo
- Realistic sky rendering with proper light scattering
- Volumetric clouds with shadows
- Sun and moon positioned for the local date and time
- Atmospheric perspective effects
- Interactive camera controls (click or scroll to take control)

To frame a different spot, change `longitude`, `latitude`, `heading`, `pitch` and `distance` in `src/main/index.ts`; to change the lighting, change `referenceDate`.

## Getting Started

### Prerequisites

- Node.js (v16 or higher recommended)
- npm or yarn
- Google Maps JavaScript API key (for Tiles demo)

### Installation

1. Clone the repository:

   ```bash
   git clone https://github.com/jalarrea/geospatial-sao-paulo.git
   cd geospatial-sao-paulo
   ```

2. Install dependencies:

   ```bash
   npm install --legacy-peer-deps
   ```

   **Note:** The `--legacy-peer-deps` flag is required due to peer dependency conflicts between packages. Specifically, `3d-tiles-renderer` requires React 18, while other dependencies (like `expo` pulled in by `@react-three/fiber`) expect React 19. This flag tells npm to use the older, more permissive dependency resolution algorithm to handle these version conflicts.

3. Create a `.env` file in the root directory with the following content:

   ```
   VITE_GOOGLE_MAPS_JS_API_KEY=your_google_maps_api_key_here
   ```

   Replace `your_google_maps_api_key_here` with your actual Google Maps JavaScript API key.

   **Important:** Make sure to enable both the **Maps JavaScript API** and **Map Tiles API** for your API key in the Google Cloud Console.

4. Start the development server:

   ```bash
   npm run dev
   ```

5. Open your browser and navigate to the URL shown in the terminal (typically http://localhost:5173).

## Other Demos (from upstream)

- **[Atmosphere](https://jeantimex.github.io/geospatial/atmosphere.html)**: A realistic Earth atmosphere visualization. This is based on @takram/three-geospatial's [Atmosphere Vanilla demo](https://takram-design-engineering.github.io/three-geospatial/?path=/story/atmosphere-atmosphere--vanilla).
- **[Clouds](https://jeantimex.github.io/geospatial/clouds.html)**: Simulate the clouds visualization. This is based on @takram/three-geospatial's [Clouds Vanilla demo](https://takram-design-engineering.github.io/three-geospatial/?path=/story/clouds-clouds--vanilla).
- **[Deferred Lighting](https://jeantimex.github.io/geospatial/deferred-lighting.html)**: Use deferred lighting technique to render the atmosphere and a simple Three.JS torus knot object.
- **[Tiles](https://jeantimex.github.io/geospatial/tiles.html)**: The vanilla implementation of rendering Google Photorealistic Tiles using [NASA-AMMOS/3DTilesRendererJS](https://github.com/NASA-AMMOS/3DTilesRendererJS) library.

## Building for Production

To build the project for production:

```bash
npm run build
```

The built files will be in the `dist` directory.

## Credits

- Original project: [jeantimex/geospatial](https://github.com/jeantimex/geospatial) by Yong Su (jeantimex), MIT License
- Atmosphere rendering based on the [@takram/three-atmosphere](https://github.com/takram-design-engineering/takram-atmosphere) library
- Earth texture assets from [NASA Visible Earth](https://visibleearth.nasa.gov/)
- 3D tiles rendering from [NASA-AMMOS/3DTilesRendererJS](https://github.com/NASA-AMMOS/3DTilesRendererJS) library
- [Google Photorealistic Tiles API](https://developers.google.com/maps/documentation/tile/3d-tiles)

## License

MIT — see [LICENSE](LICENSE). Original work © 2025 Yong Su (jeantimex).
