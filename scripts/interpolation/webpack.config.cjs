const path = require('node:path');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const webpack = require('webpack');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');

const root = path.resolve(__dirname, '../..');
const hash = (file) => createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
const sources = ['index.js', 'flowLK.js', 'flowRadar.js', 'warp.js', 'trajectories.js', 'glUtils.js', 'capabilities.js', 'frameTextures.js', 'poolController.js']
  .map((name) => `src/animation/interpolation/${name}`)
  .concat(['src/animation/budgetedCanvasSource.js', 'src/animation/framePool.js', 'src/animation/flowQueue.js']);
module.exports = {
  entry: path.join(__dirname, 'page.js'),
  output: {
    path: path.join(root, 'dist/diagnostics/interpolation'),
    filename: 'diagnostics.[contenthash].js',
    clean: true,
  },
  plugins: [
    new HtmlWebpackPlugin({ template: path.join(__dirname, 'index.html') }),
    new CopyWebpackPlugin({ patterns: [{ from: path.join(__dirname, 'fixtures'), to: 'fixtures' }] }),
    new webpack.DefinePlugin({
      DIAGNOSTIC_BUILD: JSON.stringify({
        commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
        worktreeDirty: !!execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(),
        sources: Object.fromEntries(sources.map((file) => [file, hash(file)])),
        harness: Object.fromEntries(['page.js', 'cases.js', 'trajectoryCases.js', 'trajectoryMeasurements.js', 'displayMeasurements.js', 'contextRecoveryMeasurements.js', 'frameCacheMeasurements.js', 'engine.js', 'metrics.mjs', 'index.html']
          .map((name) => [`scripts/interpolation/${name}`, hash(`scripts/interpolation/${name}`)])),
        fixtures: hash('scripts/interpolation/fixtures/manifest.json'),
      }),
    }),
  ],
  performance: { hints: false },
};
