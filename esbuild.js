const fs = require("fs")
const { context } = require("esbuild")
const dotenv = require("dotenv")

dotenv.config()

const isDev = process.argv[2] === "--dev"
const isProdBuild = process.argv[2] === "--build"

let hashIndexPlugin = {
  name: "hash-index-plugin",
  setup(build) {
    build.onStart(() => {
      const files = fs.readdirSync("app/public/dist/client")
      files.forEach((file) => {
        // remove old files
        if (file.startsWith("index-") && file.endsWith(".js")) {
          fs.unlinkSync(`app/public/dist/client/${file}`)
        }
        if (file.startsWith("index-") && file.endsWith(".css")) {
          fs.unlinkSync(`app/public/dist/client/${file}`)
        }
      })
    })
    build.onEnd((result) => {
      if (result.errors.length > 0) {
        console.log(`build ended with ${result.errors.length} errors`)
      }
      updateHashedFilesInIndex()
    })
  }
}

const clientEnvDefine = {
  "process.env.FIREBASE_API_KEY": `"${process.env.FIREBASE_API_KEY}"`,
  "process.env.FIREBASE_AUTH_DOMAIN": `"${process.env.FIREBASE_AUTH_DOMAIN}"`,
  "process.env.FIREBASE_PROJECT_ID": `"${process.env.FIREBASE_PROJECT_ID}"`,
  "process.env.FIREBASE_STORAGE_BUCKET": `"${process.env.FIREBASE_STORAGE_BUCKET}"`,
  "process.env.FIREBASE_MESSAGING_SENDER_ID": `"${process.env.FIREBASE_MESSAGING_SENDER_ID}"`,
  "process.env.FIREBASE_APP_ID": `"${process.env.FIREBASE_APP_ID}"`,
  "process.env.DISCORD_SERVER": `"${process.env.DISCORD_SERVER}"`,
  "process.env.MIN_HUMAN_PLAYERS": `"${process.env.MIN_HUMAN_PLAYERS}"`
}

context({
  entryPoints: ["./app/public/src/index.tsx"],
  entryNames: "[dir]/[name]-[hash]",
  assetNames: "[dir]/[name]-[hash]",
  outfile: "app/public/dist/client/index.js",
  external: ["assets/*"],
  bundle: true,
  metafile: true,
  minify: isProdBuild,
  sourcemap: isProdBuild,
  plugins: [hashIndexPlugin],
  target: "es2016",
  define: clientEnvDefine
})
  .then((context) => {
    if (isDev) {
      // Enable watch mode
      context.watch()
    } else {
      // Build once and exit if not in watch mode
      context.rebuild().then((result) => {
        if (result.metafile) {
          // use https://esbuild.github.io/analyze/ to analyse
          fs.writeFileSync(
            "app/public/dist/client/esbuild.meta.json",
            JSON.stringify(result.metafile)
          )
        }
        context.dispose()
      })
    }
  })
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })

// Second entry: the match-recorder WebWorker (recorder.worker.ts), built to a STABLE, unhashed filename so
// recorder.ts can load it from a fixed URL (/recorder.worker.js — dist/client is served at root). A classic
// (iife) worker — no ESM at runtime — matching the main bundle's es2016 target. Watched in dev; one-shot in
// --build. Self-contained (bundles opfs-replay-writer + replay-format + msgpackr); needs none of the env defines.
context({
  entryPoints: ["./app/public/src/game/recorder.worker.ts"],
  outfile: "app/public/dist/client/recorder.worker.js",
  bundle: true,
  format: "iife",
  target: "es2016",
  minify: isProdBuild,
  sourcemap: isProdBuild
})
  .then((workerContext) => {
    if (isDev) {
      workerContext.watch()
    } else {
      workerContext.rebuild().then(() => workerContext.dispose())
    }
  })
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })

// Third entry: the replay-index WebWorker (replay-index.worker.ts) — buildReplayIndex off the main thread
// so a long capture's multi-second index build doesn't freeze the load. Stable unhashed filename, spawned
// from /replay-index.worker.js. Same iife/es2016 shape as the recorder worker; bundles replay-index +
// @colyseus/sdk + the game enums. Watched in dev; one-shot in --build.
context({
  entryPoints: ["./app/public/src/game/replay-index.worker.ts"],
  outfile: "app/public/dist/client/replay-index.worker.js",
  bundle: true,
  format: "iife",
  target: "es2016",
  minify: isProdBuild,
  sourcemap: isProdBuild,
  // replay-index pulls in game modules that reference process.env (player.ts MODE field initializer,
  // i18n NODE_ENV); the main bundle defines the client env, and there's no `process` in a worker, so
  // supply the same defines + MODE/NODE_ENV here to avoid a "process is not defined" crash on load.
  define: {
    ...clientEnvDefine,
    "process.env.MODE": `"${process.env.MODE ?? "production"}"`,
    "process.env.NODE_ENV": `"${process.env.NODE_ENV ?? "production"}"`
  }
})
  .then((workerContext) => {
    if (isDev) {
      workerContext.watch()
    } else {
      workerContext.rebuild().then(() => workerContext.dispose())
    }
  })
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })

function updateHashedFilesInIndex() {
  //update hash in index.html
  const fs = require("fs")
  const path = require("path")

  const distDir = path.join(__dirname, "app/public/dist/client")
  const htmlFile = path.join(__dirname, "app/views/index.html")
  const htmlOutputFile = path.join(distDir, "index.html")

  // Find the hashed script file
  const scriptFile = fs
    .readdirSync(distDir)
    .find((file) => file.startsWith("index-") && file.endsWith(".js"))
  const cssFile = fs
    .readdirSync(distDir)
    .find((file) => file.startsWith("index-") && file.endsWith(".css"))

  if (scriptFile) {
    // Read the HTML file
    let htmlContent = fs.readFileSync(htmlFile, "utf8")

    // Replace the placeholder with the actual script tag
    htmlContent = htmlContent
      .replace(
        '<script src="index.js" defer></script>',
        `<script src="${scriptFile}" defer></script>`
      )
      .replace(
        `<link rel="stylesheet" type="text/css" href="index.css" />`,
        `<link rel="stylesheet" type="text/css" href="${cssFile}">`
      )

    // Write the updated HTML back to the file
    fs.writeFileSync(htmlOutputFile, htmlContent, "utf8")
  } else {
    console.error("Hashed entry files not found.")
  }
}
