const { NxAppWebpackPlugin } = require('@nx/webpack/app-plugin');
const { join } = require('path');

/**
 * Optional peer dependencies that Nest requires lazily, each behind an
 * availability check or a try/catch it never reaches here: the validation
 * decorators (there are no request DTOs yet) and the Fastify view engine
 * (there is no SSR). Leaving the require unresolved is the honest option —
 * bundling a stub would make `isClassValidatorAvailable()` answer "yes" and
 * fail further downstream.
 */
const UNUSED_OPTIONAL_PEERS = [
  /^class-validator(\/|$)/,
  /^class-transformer(\/|$)/,
  /^@fastify\/view$/,
];

module.exports = {
  externals: [
    // The function form is deliberate: a bare RegExp here defaults to a
    // `var` external, which emits `module.exports = @fastify/view` and fails
    // to parse at startup.
    ({ request }, callback) =>
      UNUSED_OPTIONAL_PEERS.some((peer) => peer.test(request))
        ? callback(null, `commonjs ${request}`)
        : callback(),
  ],
  ignoreWarnings: [
    // Some transitive dependencies ship a sourceMappingURL pointing at
    // TypeScript sources they never published. Not ours to fix, and the
    // noise would train everyone to ignore real build warnings.
    /Failed to parse source map/,
  ],
  output: {
    path: join(__dirname, 'dist'),
    clean: true,
    ...(process.env.NODE_ENV !== 'production' && {
      devtoolModuleFilenameTemplate: '[absolute-resource-path]',
    }),
  },
  plugins: [
    new NxAppWebpackPlugin({
      target: 'node',
      compiler: 'tsc',
      main: './src/main.ts',
      tsConfig: './tsconfig.app.json',
      assets: [
        './src/assets',
        // The built SPA rides along inside the server bundle, so the container
        // image is one directory and the server can find the static files
        // relative to itself. The build target depends on web:build, so this
        // input always exists by the time webpack copies it.
        {
          input: '../web/dist',
          glob: '**/*',
          output: 'public',
        },
      ],
      optimization: false,
      outputHashing: 'none',
      generatePackageJson: false,
      sourceMap: true,
      // Keep the `externals` declared above; the plugin drops them otherwise.
      mergeExternals: true,
    }),
  ],
};
