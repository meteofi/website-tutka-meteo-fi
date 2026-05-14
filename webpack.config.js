const path = require('path');
const webpack = require('webpack');
const CompressionPlugin = require('compression-webpack-plugin');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const { CleanWebpackPlugin } = require('clean-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const { GenerateSW } = require('workbox-webpack-plugin');

module.exports = (env, argv) => {
  const isProduction = argv.mode === 'production';

  return {
    devtool: isProduction ? 'source-map' : 'cheap-module-source-map',
    entry: './src/radar.js',
    output: {
      path: path.resolve(__dirname, 'dist'),
      // filename: 'radar.js'
      filename: 'radar.[contenthash].js',
    },
    resolve: {
      fallback: {
        util: require.resolve('util/'),
      },
    },
    devServer: {
      static: {
        directory: path.join(__dirname, 'dist'),
      },
      compress: true,
      port: 9000,
      open: true,
    },
    // module: {
    //     rules: [
    //       {
    //         test: /\.worker\.js$/,
    //         use: { loader: 'worker-loader' }
    //       }
    //     ]
    //   },
    plugins: [
      new webpack.ProvidePlugin({
        process: 'process/browser',
      }),
      // Only use compression in production
      ...(isProduction ? [new CompressionPlugin()] : []),
      new HtmlWebpackPlugin({
        template: './src/index.html',
      }),
      new CleanWebpackPlugin(),
      new CopyWebpackPlugin({
        patterns: [
          { from: 'assets', to: '.' },
        ],
      }),
      new webpack.DefinePlugin({
        BUILD_DATE: JSON.stringify(`${new Date().toISOString().slice(0, 16)}Z`),
      }),
      // Only generate service worker in production to avoid watch mode warnings
      ...(isProduction ? [
        new GenerateSW({
          swDest: 'sw.js',
          // skipWaiting ON, clientsClaim OFF.
          //
          // The fully message-driven activation flow (skipWaiting: false +
          // SKIP_WAITING postMessage) is correct in principle but unsafe to
          // ship in a single PR: every client currently installed is running
          // the OLD `sw-register.js` — which only knows `location.reload()`,
          // not the message handshake. With auto-skipWaiting off, those
          // old reloads do nothing (new SW stays in `waiting` forever),
          // and the user is stranded on the previous build with no path
          // forward. Telemetry post-deploy showed exactly that: zero
          // `sw-*` events recorded because no client ever made it to the
          // new code.
          //
          // `skipWaiting` alone is fine; the mid-session controller flip
          // that motivated the audit was driven by `clientsClaim`, not
          // `skipWaiting`. With clientsClaim off the new SW becomes the
          // registration's active worker on install but does NOT claim
          // existing tabs — they keep running on the old SW until the
          // user explicitly reloads (via the banner or otherwise).
          maximumFileSizeToCacheInBytes: 5000000, // 5MB
          skipWaiting: true,
          // Activate-time cleanup of stale Workbox precache caches.
          // Safe in this app because nothing is lazily code-split — all
          // JS is loaded at startup, so the running tab doesn't need
          // SW-A's precache after that point. Non-JS assets that ARE
          // fetched lazily (radars-finland.json, airfields-finland.json,
          // airspace-finland.json) are plain non-hashed filenames; if a
          // cache miss falls through to network it succeeds.
          cleanupOutdatedCaches: true,
          // Don't precache everything - be more selective
          exclude: [/\.map$/, /manifest$/, /LICENSE/],
          runtimeCaching: [{
            urlPattern: new RegExp('^https://server\\.arcgisonline\\.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/'),
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'arcgis-cache',
              expiration: {
                maxEntries: 50,
                maxAgeSeconds: 24 * 60 * 60, // 1 day
              },
            },
          },
          {
            urlPattern: new RegExp('^https://openlayers\\.org/en/latest/css/ol\\.css'),
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'openlayers-cache',
              expiration: {
                maxAgeSeconds: 7 * 24 * 60 * 60, // 1 week
              },
            },
          },
          {
            urlPattern: /radar\.css/,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'css-cache',
            },
          },
          {
            urlPattern: new RegExp('^https://fonts\\.gstatic\\.com/'),
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'google-fonts-cache',
              expiration: {
                maxAgeSeconds: 30 * 24 * 60 * 60, // 30 days
              },
            },
          },
          {
            urlPattern: new RegExp('^https://wms\\.meteo\\.fi/geoserver/.*request=GetCapabilities'),
            handler: 'NetworkFirst',
          },
          {
            urlPattern: new RegExp('^https://geoserver\\.app\\.meteo\\.fi/geoserver/.*request=GetCapabilities'),
            handler: 'NetworkFirst',
          },
          {
            urlPattern: new RegExp('^https://view\\.eumetsat\\.int/geoserv/.*request=GetCapabilities'),
            handler: 'NetworkFirst',
          },
          ],
        }),
      ] : []),
    ],
    optimization: {
      runtimeChunk: 'single',
      splitChunks: {
        chunks: 'all',
        maxInitialRequests: Infinity,
        minSize: 0,
        cacheGroups: {
          default: {
            minChunks: 2,
            priority: -20,
            reuseExistingChunk: true,
          },
          vendor: {
            test: /[\\/]node_modules[\\/]/,
            name: 'vendors',
            priority: -10,
            chunks: 'all',
          },
          openlayers: {
            test: /[\\/]node_modules[\\/]ol[\\/]/,
            name: 'openlayers',
            priority: 10,
            chunks: 'all',
          },
        },
      },
    },
  };
};
