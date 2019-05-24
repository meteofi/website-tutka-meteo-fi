const path = require('path');
const webpack = require('webpack');
const MomentLocalesPlugin = require('moment-locales-webpack-plugin');
const CompressionPlugin = require('compression-webpack-plugin');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const CleanWebpackPlugin = require('clean-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');
 
module.exports = {
    entry: './src/radar.js',
    output: {
        path: path.resolve(__dirname, 'dist'),
        //filename: 'radar.js'
        filename: 'radar.[contenthash].js',
    },
    devServer: {
        contentBase: './dist'
    },
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
        ])
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