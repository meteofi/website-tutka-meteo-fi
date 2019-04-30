const path = require('path');
const MomentLocalesPlugin = require('moment-locales-webpack-plugin');
const CompressionPlugin = require('compression-webpack-plugin');

module.exports = {
    entry: './src/radar.js',
    output: {
        filename: 'radar.js',
        path: path.resolve(__dirname, 'dist')
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
    ],
};