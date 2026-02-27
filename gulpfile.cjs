'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const fse = require('fs-extra');
const path = require('path');
const os = require('os');
const gulp = require('gulp');

const DIST_DIR = './dist/';
const APPS_DIR = './apps/';
const DEBUG_DIR = './debug/';
const RELEASE_DIR = './release/';

const LINUX_INSTALL_DIR = '/opt/betaflight';

const NW_VERSION = '0.93.0';

let metadata = {};

// -----------------
// Platform Detection
// -----------------

const SELECTED_PLATFORMS = getInputPlatforms();

function getInputPlatforms() {
    const supportedPlatforms = ['linux64', 'linux32', 'osx64', 'win32', 'win64', 'android'];
    const platforms = [];
    const regEx = /--(\w+)/;

    for (let i = 3; i < process.argv.length; i++) {
        const match = process.argv[i].match(regEx);
        if (match) {
            const arg = match[1];
            if (supportedPlatforms.indexOf(arg) > -1) {
                platforms.push(arg);
            } else if (arg === 'nowinicon') {
                console.log('Ignoring winIco');
            }
        }
    }

    if (platforms.length === 0) {
        const defaultPlatform = getDefaultPlatform();
        if (defaultPlatform) {
            platforms.push(defaultPlatform);
        }
    }

    if (platforms.length > 0) {
        console.log(`Building for platform(s): ${platforms}`);
    } else {
        console.error('No suitable platforms found.');
        process.exit(1);
    }

    return platforms;
}

function getDefaultPlatform() {
    switch (os.platform()) {
    case 'darwin':
        return 'osx64';
    case 'linux':
        return 'linux64';
    case 'win32':
        return 'win64';
    default:
        return '';
    }
}

function getPlatforms() {
    return SELECTED_PLATFORMS.slice();
}

// -----------------
// Metadata
// -----------------

function loadMetadata(isReleaseBuild) {
    const pkg = JSON.parse(fs.readFileSync('./package.json', 'utf-8'));
    metadata = {
        name: pkg.name,
        productName: pkg.productName,
        description: pkg.description,
        version: pkg.version,
        author: pkg.author,
        license: pkg.license,
    };

    if (!isReleaseBuild) {
        let gitRevision = 'norevision';
        try {
            gitRevision = execSync('git rev-parse --short HEAD').toString().trim();
        } catch (_e) {
            // Ignore git errors
        }
        metadata.productName += ' (Debug Build)';
        metadata.description += ' (Debug Build)';
        metadata.version += `-debug-${gitRevision}`;
    }
}

// -----------------
// Helper functions
// -----------------

function getReleaseFilename(platform, ext, portable) {
    return `${metadata.name}_${metadata.version}_${platform}${portable ? '-portable' : ''}.${ext}`;
}

function createDirIfNotExists(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

// -----------------
// Clean Tasks
// -----------------

function clean_dist(done) {
    fse.emptyDirSync(DIST_DIR);
    done();
}

function clean_apps(done) {
    fse.removeSync(APPS_DIR);
    done();
}

function clean_debug(done) {
    fse.removeSync(DEBUG_DIR);
    done();
}

function clean_release(done) {
    fse.removeSync(RELEASE_DIR);
    done();
}

gulp.task('clean', gulp.parallel(clean_dist, clean_apps, clean_debug, clean_release));
gulp.task('clean-dist', clean_dist);
gulp.task('clean-apps', clean_apps);
gulp.task('clean-debug', clean_debug);
gulp.task('clean-release', clean_release);

// -----------------
// Dist Tasks
// -----------------

function dist_vite(done) {
    execSync('npx vite build', { stdio: 'inherit' });
    done();
}

function dist_copy(done) {
    fse.copySync('./src/dist', DIST_DIR);
    done();
}

function dist_locales(done) {
    // Copy locales if not already present (Vite copy plugin may have done this)
    const dest = path.join(DIST_DIR, 'locales');
    if (!fs.existsSync(dest) || fs.readdirSync(dest).length === 0) {
        fse.copySync('./locales', dest);
    }
    done();
}

function dist_resources(done) {
    // Copy resources if not already present
    const dest = path.join(DIST_DIR, 'resources');
    if (!fs.existsSync(dest) || fs.readdirSync(dest).length === 0) {
        fse.copySync('./resources', dest);
    }
    done();
}

function dist_package(done) {
    const pkg = JSON.parse(fs.readFileSync('./package.json', 'utf-8'));
    const distPkg = {
        name: metadata.name || pkg.name,
        productName: metadata.productName || pkg.productName,
        description: metadata.description || pkg.description,
        version: metadata.version || pkg.version,
        author: pkg.author,
        license: pkg.license,
        main: 'index.html',
        window: pkg.window,
        dependencies: {
            'serialport': '^12.0.0',
        },
    };
    fs.writeFileSync(
        path.join(DIST_DIR, 'package.json'),
        JSON.stringify(distPkg, null, 2),
    );
    done();
}

function dist_native_modules(done) {
    try {
        execSync('npm install --production', {
            cwd: path.resolve(DIST_DIR),
            stdio: 'inherit',
        });
        console.log('Native serial modules installed successfully');
    } catch (error) {
        console.warn('Warning: Failed to install native modules:', error.message);
        console.warn('The desktop build will fall back to Web Serial API.');
    }
    done();
}

// -----------------
// NW.js Build Tasks
// -----------------

// Convert old-style platform strings to nw-builder 4.x format
function parsePlatform(platformStr) {
    if (platformStr === 'osx64') return { platform: 'osx', arch: 'x64' };
    if (platformStr === 'linux64') return { platform: 'linux', arch: 'x64' };
    if (platformStr === 'linux32') return { platform: 'linux', arch: 'ia32' };
    if (platformStr === 'win64') return { platform: 'win', arch: 'x64' };
    if (platformStr === 'win32') return { platform: 'win', arch: 'ia32' };
    throw new Error(`Unknown platform: ${platformStr}`);
}

async function buildNWApps(platforms, flavor, dir, done) {
    if (platforms.length === 0) {
        console.log('No platforms to build for');
        done();
        return;
    }

    const nwbuild = (await import('nw-builder')).default;

    for (const platformStr of platforms) {
        const { platform, arch } = parsePlatform(platformStr);
        const outDir = path.join(dir, metadata.name || 'betaflight-app', platformStr);

        const app = {};
        if (platform === 'osx') {
            app.name = metadata.productName || 'Betaflight Configurator';
            app.icon = './src/images/bf_icon.icns';
            app.CFBundleDisplayName = 'Betaflight Configurator';
        } else if (platform === 'win') {
            app.name = metadata.productName || 'Betaflight Configurator';
            app.icon = './src/images/bf_icon.ico';
        } else if (platform === 'linux') {
            app.name = metadata.name || 'betaflight-app';
            app.icon = './src/images/bf_icon_128.png';
        }

        console.log(`Building NW.js app for ${platformStr} (${platform}-${arch})...`);

        await nwbuild({
            mode: 'build',
            version: NW_VERSION,
            flavor: flavor,
            platform: platform,
            arch: arch,
            srcDir: DIST_DIR,
            outDir: outDir,
            glob: false,
            app: app,
            zip: false,
        });

        console.log(`Built ${platformStr} successfully`);
    }

    done();
}

function apps(done) {
    const platforms = getPlatforms().filter(function(p) { return p !== 'android'; });
    buildNWApps(platforms, 'normal', APPS_DIR, done);
}

function debug_apps(done) {
    const platforms = getPlatforms().filter(function(p) { return p !== 'android'; });
    buildNWApps(platforms, 'sdk', DEBUG_DIR, done);
}

function post_build_linux(done) {
    const platforms = getPlatforms();
    const linuxPlatforms = platforms.filter(function(p) {
        return p.startsWith('linux');
    });

    for (const arch of linuxPlatforms) {
        const launcherDir = path.join(APPS_DIR, metadata.name, arch);
        if (fs.existsSync(launcherDir) && fs.existsSync('assets/linux')) {
            fse.copySync('assets/linux', launcherDir);
        }
    }
    done();
}

function post_build_linux_debug(done) {
    const platforms = getPlatforms();
    const linuxPlatforms = platforms.filter(function(p) {
        return p.startsWith('linux');
    });

    for (const arch of linuxPlatforms) {
        const launcherDir = path.join(DEBUG_DIR, metadata.name, arch);
        if (fs.existsSync(launcherDir) && fs.existsSync('assets/linux')) {
            fse.copySync('assets/linux', launcherDir);
        }
    }
    done();
}

// -----------------
// Release Tasks
// -----------------

function release_zip(arch, appDirectory, done) {
    const srcDir = path.join(appDirectory, metadata.name, arch);
    const outputFile = path.join(RELEASE_DIR, getReleaseFilename(arch, 'zip', true));

    createDirIfNotExists(RELEASE_DIR);

    try {
        if (os.platform() === 'win32') {
            execSync(
                `powershell -command "Compress-Archive -Path '${srcDir}${path.sep}*' -DestinationPath '${outputFile}'"`,
                { stdio: 'inherit' },
            );
        } else {
            execSync(
                `cd "${srcDir}" && zip -r "${path.resolve(outputFile)}" .`,
                { stdio: 'inherit' },
            );
        }
        console.log(`Created: ${outputFile}`);
    } catch (error) {
        console.error(`Error creating zip for ${arch}:`, error.message);
    }
    done();
}

function release_win(arch, appDirectory, done) {
    let innoSetup;
    try {
        innoSetup = require('@quanle94/innosetup');
    } catch (_e) {
        console.warn('InnoSetup not available, skipping Windows installer');
        done();
        return;
    }

    const parameters = [];
    parameters.push(`/Dversion=${metadata.version}`);
    parameters.push(`/DarchName=${arch}`);
    parameters.push(`/DarchAllowed=${arch === 'win32' ? 'x86 x64' : 'x64'}`);
    parameters.push(`/DarchInstallIn64bit=${arch === 'win32' ? '' : 'x64'}`);
    parameters.push(`/DsourceFolder=${appDirectory}`);
    parameters.push(`/DtargetFolder=${RELEASE_DIR}`);
    parameters.push('/Q');
    parameters.push('assets/windows/installer.iss');

    innoSetup(parameters, {}, function(error) {
        if (error) {
            console.error(`Installer for ${arch} failed: ${error}`);
        } else {
            console.log(`Installer for ${arch} completed`);
        }
        done();
    });
}

function release_deb(arch, appDirectory, done) {
    const commandExistsSync = require('command-exists').sync;

    if (!commandExistsSync('dpkg-deb')) {
        console.warn(`dpkg-deb not found, skipping deb for ${arch}`);
        done();
        return;
    }

    createDirIfNotExists(RELEASE_DIR);

    const debArch = arch === 'linux64' ? 'amd64' : 'i386';
    const debDir = path.join(RELEASE_DIR, `deb-${arch}`);
    const installDir = path.join(LINUX_INSTALL_DIR, metadata.name);

    // Create deb structure
    fse.mkdirpSync(path.join(debDir, 'DEBIAN'));
    fse.mkdirpSync(path.join(debDir, installDir));

    // Copy app files
    fse.copySync(
        path.join(appDirectory, metadata.name, arch),
        path.join(debDir, installDir),
    );

    // Create control file
    const control = [
        `Package: ${metadata.name}`,
        `Version: ${metadata.version}`,
        `Architecture: ${debArch}`,
        `Maintainer: ${metadata.author}`,
        `Description: ${metadata.description}`,
        'Section: base',
        'Priority: optional',
        'Depends: libgconf-2-4, libatomic1',
        '',
    ].join('\n');
    fs.writeFileSync(path.join(debDir, 'DEBIAN', 'control'), control);

    // Create postinst script
    const postinst = [
        '#!/bin/bash',
        `chown root:root ${LINUX_INSTALL_DIR}`,
        `chown -R root:root ${installDir}`,
        `xdg-desktop-menu install ${installDir}/${metadata.name}.desktop 2>/dev/null || true`,
        `chmod +xr ${installDir}/${metadata.name}`,
        `chmod -R +Xr ${installDir}/`,
        '',
    ].join('\n');
    fs.writeFileSync(path.join(debDir, 'DEBIAN', 'postinst'), postinst, { mode: 0o755 });

    // Build deb
    const output = path.join(RELEASE_DIR, getReleaseFilename(arch, 'deb'));
    try {
        execSync(`dpkg-deb --build "${debDir}" "${output}"`, { stdio: 'inherit' });
        console.log(`Created: ${output}`);
    } catch (error) {
        console.error(`Error creating deb for ${arch}:`, error.message);
    }

    // Clean up
    fse.removeSync(debDir);
    done();
}

function release_rpm(arch, appDirectory, done) {
    const commandExistsSync = require('command-exists').sync;

    if (!commandExistsSync('rpmbuild')) {
        console.warn(`rpmbuild not found, skipping rpm for ${arch}`);
        done();
        return;
    }

    let buildRpm;
    try {
        buildRpm = require('rpm-builder');
    } catch (_e) {
        console.warn('rpm-builder not available, skipping rpm');
        done();
        return;
    }

    createDirIfNotExists(RELEASE_DIR);

    const rpmArch = arch === 'linux64' ? 'x86_64' : 'i386';
    const options = {
        name: metadata.name,
        version: metadata.version.replace(/-/g, '_'),
        buildArch: rpmArch,
        vendor: metadata.author,
        summary: metadata.description,
        license: 'GNU General Public License v3.0',
        requires: ['GConf2', 'libatomic'],
        prefix: '/opt',
        files: [{
            cwd: path.join(appDirectory, metadata.name, arch),
            src: '*',
            dest: `${LINUX_INSTALL_DIR}/${metadata.name}`,
        }],
        postInstallScript: [
            `chown root:root ${LINUX_INSTALL_DIR}`,
            `chown -R root:root ${LINUX_INSTALL_DIR}/${metadata.name}`,
            `xdg-desktop-menu install ${LINUX_INSTALL_DIR}/${metadata.name}/${metadata.name}.desktop`,
            `chmod +xr ${LINUX_INSTALL_DIR}/${metadata.name}/${metadata.name}`,
            `chmod -R +Xr ${LINUX_INSTALL_DIR}/${metadata.name}/`,
        ],
        preUninstallScript: [`xdg-desktop-menu uninstall ${metadata.name}.desktop`],
        tempDir: path.join(RELEASE_DIR, `tmp-rpm-build-${arch}`),
        keepTemp: false,
        verbose: false,
        rpmDest: RELEASE_DIR,
        execOpts: { maxBuffer: 1024 * 1024 * 16 },
    };

    buildRpm(options, function(err) {
        if (err) {
            console.error(`Error creating rpm for ${arch}:`, err);
        }
        done();
    });
}

// Build release tasks list based on selected platforms
function listReleaseTasks(appDirectory) {
    const platforms = getPlatforms();
    const tasks = [];

    for (const platform of platforms) {
        if (platform.startsWith('linux')) {
            tasks.push(function(done) { release_zip(platform, appDirectory, done); });
            tasks.push(function(done) { release_deb(platform, appDirectory, done); });
            tasks.push(function(done) { release_rpm(platform, appDirectory, done); });
        }
        if (platform.startsWith('win')) {
            tasks.push(function(done) { release_zip(platform, appDirectory, done); });
            tasks.push(function(done) { release_win(platform, appDirectory, done); });
        }
        if (platform === 'osx64') {
            tasks.push(function(done) { release_zip('osx64', appDirectory, done); });
        }
    }

    if (tasks.length === 0) {
        tasks.push(function noop(done) { done(); });
    }

    return tasks;
}

// -----------------
// Gulp Task Definitions
// -----------------

// Dist build (Vite + NW.js packaging prep)
const distRelease = gulp.series(
    function initReleaseMeta(done) { loadMetadata(true); done(); },
    clean_dist,
    dist_vite,
    dist_copy,
    dist_locales,
    dist_resources,
    dist_package,
    dist_native_modules,
);

const distDebug = gulp.series(
    function initDebugMeta(done) { loadMetadata(false); done(); },
    clean_dist,
    dist_vite,
    dist_copy,
    dist_locales,
    dist_resources,
    dist_package,
    dist_native_modules,
);

// Release build: dist → NW.js apps → platform packages
const releaseBuild = gulp.series(
    distRelease,
    clean_apps,
    apps,
    post_build_linux,
    clean_release,
    gulp.parallel(...listReleaseTasks(APPS_DIR)),
);

gulp.task('release', releaseBuild);

// Debug release build
const debugReleaseBuild = gulp.series(
    distDebug,
    clean_debug,
    debug_apps,
    post_build_linux_debug,
    clean_release,
    gulp.parallel(...listReleaseTasks(DEBUG_DIR)),
);

gulp.task('debug-release', debugReleaseBuild);

// Dist only (for inspection)
gulp.task('dist', distRelease);

gulp.task('default', debugReleaseBuild);
