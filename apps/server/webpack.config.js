const { NxAppWebpackPlugin } = require('@nx/webpack/app-plugin');
const { join } = require('path');

/**
 * Nest features this app does not use, each reached only through an
 * `optionalRequire` that returns `{}` on failure or a `loadPackage` inside a
 * method we never call:
 *
 * - validation decorators — there are no request DTOs yet;
 * - the Fastify view engine — there is no SSR;
 * - microservices and websockets — Rocky is one HTTP process;
 * - the Express adapter — Rocky runs on Fastify, and Nest only reaches for
 *   Express when `NestFactory.create` is called without an adapter, which
 *   `createApp` never does.
 *
 * Leaving the require unresolved is the honest option. Bundling a stub would
 * make `isClassValidatorAvailable()` answer "yes" and fail further downstream,
 * and would hide the "install @nestjs/microservices" error that is exactly
 * what someone adding a microservice should see.
 */
const UNUSED_OPTIONAL_PEERS = [
  /^class-validator(\/|$)/,
  /^class-transformer(\/|$)/,
  /^@fastify\/view$/,
  /^@nestjs\/microservices(\/|$)/,
  /^@nestjs\/websockets(\/|$)/,
  /^@nestjs\/platform-express(\/|$)/,
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
    // Nest resolves optional packages through `require(someVariable)`, which
    // webpack cannot follow. That is the intended behaviour for the very
    // packages listed above. Scoped to dependencies on purpose: the same
    // warning in our own code would be worth reading.
    (warning) =>
      /Critical dependency: the request of a dependency is an expression/.test(
        warning.message ?? '',
      ) && /node_modules/.test(warning.module?.resource ?? ''),
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
