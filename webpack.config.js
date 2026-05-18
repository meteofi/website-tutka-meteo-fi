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
          // skipWaiting + clientsClaim, both ON. This is the pre-audit
          // configuration, restored after a real-world failure mode
          // surfaced in iOS Safari standalone PWAs and prod Mac Safari:
          //
          // With `clientsClaim: false` the new SW activates but does NOT
          // claim the open tabs. The previous active SW transitions to
          // `redundant`, and WebKit (per its current implementation)
          // returns `null` from `navigator.serviceWorker.controller`
          // when the controlling SW is redundant and no successor has
          // claimed the client. Both the OLD and NEW `sw-register.js`
          // gate the update banner on `controller` being truthy
          // (to distinguish "first install" from "update available"),
          // so the banner was never shown to anyone running with the
          // previous deploy still in their precache.
          //
          // With `clientsClaim: true` the new SW immediately controls
          // the open tabs, `controller` flips from old → new (both
          // truthy), the gated banner check passes, and we additionally
          // get a `controllerchange` event the page can use to reload
          // itself (see sw-register.js).
          //
          // The chunk-404 risk that originally motivated dropping
          // `clientsClaim` doesn't apply to this app: we have zero
          // dynamic imports (verified by `grep -rn 'import(' src/`),
          // so the in-memory page never refetches its JS bundles
          // after the controller flips. Lazy non-JS fetches
          // (radars-finland.json, airfields-finland.json,
          // airspace-finland.json) are plain non-hashed filenames and
          // exist under the same URL in the new precache.
          maximumFileSizeToCacheInBytes: 5000000, // 5MB
          skipWaiting: true,
          clientsClaim: true,
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
