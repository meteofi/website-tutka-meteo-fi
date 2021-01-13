const path = require('path');
const webpack = require('webpack');
const MomentLocalesPlugin = require('moment-locales-webpack-plugin');
const CompressionPlugin = require('compression-webpack-plugin');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const CleanWebpackPlugin = require('clean-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const workboxPlugin = require('workbox-webpack-plugin');
 
module.exports = {
    entry: './src/radar.js',
    output: {
        path: path.resolve(__dirname, 'dist'),
        //filename: 'radar.js'
        filename: 'radar.[contenthash].js',
    },
    devServer: {
        contentBase: path.join(__dirname, 'dist'),
        compress: true,
        port: 9000
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
        new webpack.HashedModuleIdsPlugin(),
        new HtmlWebpackPlugin({
          //title: 'Output Management',
          template: './src/index.html'
        }),
        new CleanWebpackPlugin(),
        new CopyWebpackPlugin([
            { from: 'assets', to: '.' }
        ]),
        new workboxPlugin.GenerateSW({
            swDest: 'sw.js',
            clientsClaim: true,
            skipWaiting: true,
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
                urlPattern: new RegExp('https://geoserver.apps.meteo.fi/geoserver/.*request=GetCapabilities'),
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
            cacheGroups: {
                vendor: {
                    test: /[\\/]node_modules[\\/]/,
                    name: 'vendors',
                    chunks: 'all'
                }
            }
        }
    }
};