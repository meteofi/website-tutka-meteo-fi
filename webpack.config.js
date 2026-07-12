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
      // Async (lazy) chunks keep their own name — the mqtt chunk must be
      // distinguishable from the eager radar.* bundles so GenerateSW can skip
      // precaching it and sw-register.js can self-heal a stale-hash load.
      chunkFilename: '[name].[contenthash].js',
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
    module: {
      rules: [
        // Bundled GeoJSON data (place names) is emitted as a content-hashed
        // asset so it rides the immutable-cache path like the JS bundles.
        // The .geojson extension is deliberate: firebase.json serves
        // **/*.json with Cache-Control: no-cache (right for manifest-style
        // files, wrong for 1 MB of hashed data) and *.geojson gets its own
        // immutable header rule there. Importing the file yields its URL.
        {
          test: /\.geojson$/,
          type: 'asset/resource',
          generator: { filename: '[name].[contenthash][ext]' },
        },
      ],
    },
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
          // `clientsClaim` is narrow in this app: the ONLY dynamic
          // import is the AIS mqtt chunk (src/ais/aisClient.js), which
          // is excluded from the precache below. If a stale page
          // requests an old-hash mqtt chunk right after a deploy, the
          // controllerchange auto-reload (sw-register.js) usually gets
          // there first; failing that, the sw-register self-heal
          // listener matches mqtt.*.js and recovers with an
          // unregister + reload, and aisClient catches the import()
          // rejection and degrades to a recoverable error state.
          // Lazy non-JS fetches (the content-hashed *.geojson data
          // assets) are precached, so a stale page finds its old-hash
          // URL in its own SW's precache until the controllerchange
          // reload lands.
          maximumFileSizeToCacheInBytes: 5000000, // 5MB
          skipWaiting: true,
          clientsClaim: true,
          // Activate-time cleanup of stale Workbox precache caches.
          // Safe in this app because the eager JS is all loaded at
          // startup, so the running tab doesn't need SW-A's precache
          // after that point. The one lazily code-split chunk (mqtt,
          // AIS own-location source) is excluded from the precache and
          // has the recovery ladder described above. Non-JS assets that
          // ARE fetched lazily (the content-hashed *.geojson data
          // assets) are precached; a post-deploy stale tab that lazily
          // fetches an old-hash geojson after cleanup can 404, but the
          // controllerchange auto-reload closes that window in seconds.
          cleanupOutdatedCaches: true,
          // Don't precache everything - be more selective. The mqtt
          // chunk is lazy on purpose: precaching it would make every
          // GPS-only user download it in the background, and AIS needs
          // the network anyway.
          exclude: [/\.map$/, /manifest$/, /LICENSE/, /^mqtt[.-][^/]*\.js$/],
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
          // mqtt is loaded via dynamic import() only when the user activates
          // the AIS own-location source, and must stay OUT of the eager
          // bundles. The vendor group's fixed name + chunks:'all' merges any
          // matching async module into the initial vendors chunk regardless
          // of other groups' priority (same-name chunk merge happens after
          // group assignment), so the vendor test itself must exclude mqtt —
          // the negative lookahead below is the load-bearing part. This group
          // then names the async chunk deterministically ("mqtt.<hash>.js")
          // for the GenerateSW exclude and the sw-register self-heal regex.
          mqtt: {
            test: /[\\/]node_modules[\\/]mqtt[\\/]/,
            name: 'mqtt',
            priority: 20,
            chunks: 'async',
          },
          vendor: {
            test: /[\\/]node_modules[\\/](?!mqtt[\\/])/,
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
