const path = require('path');
const webpack = require('webpack');
const MomentLocalesPlugin = require('moment-locales-webpack-plugin');
const CompressionPlugin = require('compression-webpack-plugin');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const { CleanWebpackPlugin } = require('clean-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const { GenerateSW } = require('workbox-webpack-plugin');
 
module.exports = {
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
        // To strip all locales except “en”
        //new MomentLocalesPlugin(),

        // Or: To strip all locales except “en”, “es-us” and “ru”
        // (“en” is built into Moment and can’t be removed)
        new MomentLocalesPlugin({
            localesToKeep: ['fi'],
        }),
        new CompressionPlugin(),
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
        new GenerateSW({
            swDest: 'sw.js',
            clientsClaim: true,
            skipWaiting: true,
            maximumFileSizeToCacheInBytes: 5000000, // 5MB
            runtimeCaching: [{
                urlPattern: new RegExp('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/'),
                handler: 'StaleWhileRevalidate'
            },
            {
                urlPattern: new RegExp('https://openlayers.org/en/latest/css/ol.css'),
                handler: 'StaleWhileRevalidate'
            },
            {
                urlPattern: new RegExp('radar.css'),
                handler: 'StaleWhileRevalidate'
            },
            {
                urlPattern: new RegExp('https://fonts.gstatic.com/'),
                handler: 'StaleWhileRevalidate'
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
                },
                moment: {
                    test: /[\\/]node_modules[\\/]moment[\\/]/,
                    name: 'moment',
                    priority: 10,
                    chunks: 'all'
                }
            }
        }
    }
};