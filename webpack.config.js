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
    entry: './src/radar.js',
    output: {
        path: path.resolve(__dirname, 'dist'),
        //filename: 'radar.js'
        filename: 'radar.[contenthash].js',
    },
    resolve: {
        fallback: {
            "util": require.resolve("util/"),
            "url": require.resolve("url/"),
            "buffer": require.resolve("buffer/"),
            "stream": require.resolve("stream-browserify"),
            "path": require.resolve("path-browserify"),
            "os": require.resolve("os-browserify/browser"),
            "process": require.resolve("process/browser"),
            "net": false,
            "tls": false,
            "fs": false
        }
    },
    devServer: {
        static: {
            directory: path.join(__dirname, 'dist'),
        },
        compress: true,
        port: 9000,
        open: true
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
        // Only use compression in production
        ...(process.env.NODE_ENV === 'production' ? [new CompressionPlugin()] : []),
        new HtmlWebpackPlugin({
          template: './src/index.html'
        }),
        new CleanWebpackPlugin(),
        new CopyWebpackPlugin({
            patterns: [
                { from: 'assets', to: '.' }
            ]
        }),
        new webpack.ProvidePlugin({
            Buffer: ['buffer', 'Buffer'],
            process: 'process/browser',
        }),
        new webpack.DefinePlugin({
            'process.env': JSON.stringify({}),
            'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'development'),
        }),
        new webpack.DefinePlugin({
            'BUILD_DATE': JSON.stringify(new Date().toISOString().slice(0, 16) + 'Z')
        }),
        // Only generate service worker in production to avoid watch mode warnings
        ...(process.env.NODE_ENV === 'production' ? [
            new GenerateSW({
                swDest: 'sw.js',
                clientsClaim: true,
                skipWaiting: true,
                maximumFileSizeToCacheInBytes: 5000000, // 5MB
                // Add cache busting strategy
                cleanupOutdatedCaches: true,
                // Don't precache everything - be more selective
                exclude: [/\.map$/, /manifest$/, /LICENSE/],
                runtimeCaching: [{
                    urlPattern: new RegExp('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/'),
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
                    urlPattern: new RegExp('https://openlayers.org/en/latest/css/ol.css'),
                    handler: 'StaleWhileRevalidate',
                    options: {
                        cacheName: 'openlayers-cache',
                        expiration: {
                            maxAgeSeconds: 7 * 24 * 60 * 60, // 1 week
                        },
                    },
                },
                {
                    urlPattern: new RegExp('radar.css'),
                    handler: 'StaleWhileRevalidate',
                    options: {
                        cacheName: 'css-cache',
                    },
                },
                {
                    urlPattern: new RegExp('https://fonts.gstatic.com/'),
                    handler: 'StaleWhileRevalidate',
                    options: {
                        cacheName: 'google-fonts-cache',
                        expiration: {
                            maxAgeSeconds: 30 * 24 * 60 * 60, // 30 days
                        },
                    },
                },
                {
                    urlPattern: new RegExp('https://wms.meteo.fi/geoserver/.*request=GetCapabilities'),
                    handler: 'NetworkFirst'
                },
                {
                    urlPattern: new RegExp('https://geoserver.app.meteo.fi/geoserver/.*request=GetCapabilities'),
                    handler: 'NetworkFirst'
                },
                {
                    urlPattern: new RegExp('https://view.eumetsat.int/geoserv/.*request=GetCapabilities'),
                    handler: 'NetworkFirst'
                }
            ]
            })
        ] : [])
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
                    reuseExistingChunk: true
                },
                vendor: {
                    test: /[\\/]node_modules[\\/]/,
                    name: 'vendors',
                    priority: -10,
                    chunks: 'all'
                },
                openlayers: {
                    test: /[\\/]node_modules[\\/]ol[\\/]/,
                    name: 'openlayers',
                    priority: 10,
                    chunks: 'all'
                }
            }
        }
    }
};
};