#!/usr/bin/env node

/**
 * Desktop Build Script for Betaflight Configurator
 *
 * Creates local release builds for Windows and macOS using NW.js.
 *
 * Usage:
 *   node desktop-build.mjs --win64       Build for Windows 64-bit
 *   node desktop-build.mjs --osx64       Build for macOS 64-bit
 *   node desktop-build.mjs --win64 --osx64  Build for both platforms
 *
 * Options:
 *   --skip-build   Skip the Vite build step (use existing src/dist)
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = __dirname;

const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf-8"));

// Parse CLI arguments
const args = process.argv.slice(2);
const platforms = [];
if (args.includes("--win64")) platforms.push("win64");
if (args.includes("--osx64")) platforms.push("osx64");
if (args.includes("--linux64")) platforms.push("linux64");
const skipBuild = args.includes("--skip-build");

if (platforms.length === 0) {
    console.error("Error: No platform specified.");
    console.error("Usage: node desktop-build.mjs --win64 | --osx64 | --linux64");
    console.error("  Combine flags to build for multiple platforms.");
    console.error("  Add --skip-build to skip the Vite build step.");
    process.exit(1);
}

const NW_VERSION = "stable";
const RELEASE_DIR = path.join(rootDir, "release");
const APPS_DIR = path.join(rootDir, "apps");
const CACHE_DIR = path.join(rootDir, "cache");
const DIST_DIR = path.join(rootDir, "src", "dist");

async function viteBuild() {
    if (skipBuild) {
        console.log("Skipping Vite build (--skip-build)...");
        if (!fs.existsSync(path.join(DIST_DIR, "index.html"))) {
            console.error("Error: src/dist/index.html not found. Run 'yarn build' first or remove --skip-build.");
            process.exit(1);
        }
        return;
    }
    console.log("Running Vite build...");
    execSync("npx vite build", { cwd: rootDir, stdio: "inherit" });
}

function prepareNwAppDir() {
    console.log("Preparing NW.js app directory...");

    // Clean and create apps directory
    if (fs.existsSync(APPS_DIR)) {
        fs.rmSync(APPS_DIR, { recursive: true });
    }
    fs.mkdirSync(APPS_DIR, { recursive: true });

    // Copy built files from src/dist to apps directory
    copyDirSync(DIST_DIR, APPS_DIR);

    // Create NW.js-compatible package.json in the app directory
    const nwPkg = {
        name: pkg.name,
        productName: pkg.productName,
        version: pkg.version,
        description: pkg.description,
        main: "index.html",
        window: {
            icon: "images/bf_icon_128.png",
            id: "main-window",
            min_width: 1024,
            min_height: 550,
            title: `${pkg.productName} - ${pkg.version}`,
        },
    };

    fs.writeFileSync(path.join(APPS_DIR, "package.json"), JSON.stringify(nwPkg, null, 2));
    console.log("NW.js app directory prepared at:", APPS_DIR);
}

function copyDirSync(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            copyDirSync(srcPath, destPath);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

async function buildDesktop() {
    console.log(`Building for platforms: ${platforms.join(", ")}...`);
    console.log(`NW.js version: ${NW_VERSION}`);

    // Clean release directory
    if (fs.existsSync(RELEASE_DIR)) {
        fs.rmSync(RELEASE_DIR, { recursive: true });
    }
    fs.mkdirSync(RELEASE_DIR, { recursive: true });

    // Use nw-builder programmatic API
    const NwBuilder = (await import("nw-builder")).default;

    // nw-builder's copyNwjs() passes each globbed file path as the last
    // argument to path.resolve() when building the destination.  If the
    // file path is absolute, path.resolve() returns it unchanged, making
    // src === dest and triggering EINVAL.  Work around this by switching
    // CWD into the app directory so the glob returns relative paths.
    const originalCwd = process.cwd();
    process.chdir(APPS_DIR);

    const nw = new NwBuilder({
        files: ["**/*"],
        version: NW_VERSION,
        flavor: "normal",
        platforms: platforms,
        buildDir: RELEASE_DIR,
        cacheDir: CACHE_DIR,
        appName: "betaflight-app",
        appVersion: pkg.version,
        buildType: "versioned",
        winIco: platforms.includes("win64") ? path.join(rootDir, "src", "images", "bf_icon.ico") : undefined,
        macIcns: platforms.includes("osx64") ? path.join(rootDir, "src", "images", "bf_icon.icns") : undefined,
        zip: false,
    });

    try {
        await nw.build();
        console.log("\nBuild complete! Output in:", RELEASE_DIR);
        listBuilds();
    } catch (err) {
        console.error("Build failed:", err.message || err);
        process.exit(1);
    } finally {
        process.chdir(originalCwd);
    }
}

function listBuilds() {
    console.log("\nGenerated release artifacts:");
    if (fs.existsSync(RELEASE_DIR)) {
        const entries = fs.readdirSync(RELEASE_DIR);
        for (const entry of entries) {
            const fullPath = path.join(RELEASE_DIR, entry);
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
                console.log(`  📁 ${entry}/`);
            } else {
                const sizeMB = (stat.size / (1024 * 1024)).toFixed(2);
                console.log(`  📄 ${entry} (${sizeMB} MB)`);
            }
        }
    }
}

async function main() {
    console.log(`\n=== Betaflight Configurator Desktop Build ===`);
    console.log(`Version: ${pkg.version}`);
    console.log(`Platforms: ${platforms.join(", ")}\n`);

    await viteBuild();
    prepareNwAppDir();
    await buildDesktop();
}

main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});
