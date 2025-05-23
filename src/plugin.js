// IMPORTS
const path = require('path')
const { promises: fs } = require('fs');
const pm = require('picomatch')
const { JSDOM } = require('jsdom')
const walk = require('./utils/walk')
const hashFile = require('./utils/hashFile')
const resolveFile = require('./utils/resolveFile')
// END IMPORTS

const PREFIX = 'Eleventy-Plugin-Page-Assets'
const LOG_PREFIX = `[\x1b[34m${PREFIX}\x1b[0m]`

const pluginOptions = {
    mode: 'parse', // directory|parse
    postsMatching: '*.md',
    assetsMatching: '*.png|*.jpg|*.gif',

    recursive: false, // only mode:directory

    hashAssets: true, // only mode:parse
    hashingAlg: 'sha1', // only mode:parse
    hashingDigest: 'hex', // only mode:parse

    forceCopy: false, // if `true` copy files even if modification dates and sizes match

    addIntegrityAttribute: true,
    silent: false
}

const isRelative = (url) => !/^https?:/.test(url)

async function copyFileIfNeeded(src, dest) {
    const src_stat = await fs.stat(src);
    if (!pluginOptions.forceCopy) {
        try {
            const dest_stat = await fs.stat(dest);
            if (+dest_stat.mtime == +src_stat.mtime && dest_stat.size == src_stat.size) {
                return;
            }
            console.log(LOG_PREFIX, `${src} has changed!`);
        } catch {} // `dest` does not exist
    }
    if (!pluginOptions.silent) {
        console.log(LOG_PREFIX, `Copy ${src} to ${dest}..`);
    }
    await fs.copyFile(src, dest);
    // `copyFile` does not copy attributes, so we have to copy time attributes
    await fs.utimes(dest, src_stat.atime, src_stat.mtime);
}

async function transformParser(content, outputPath) {
    const template = this
    if (outputPath && outputPath.endsWith('.html')) {
        const inputPath = template.inputPath

        if (
            pm.isMatch(inputPath, pluginOptions.postsMatching, {
                contains: true
            })
        ) {
            const templateDir = path.dirname(template.inputPath)
            const outputDir = path.dirname(outputPath)

            // parse
            const dom = new JSDOM(content)
            const elms = [...dom.window.document.querySelectorAll('img')] //TODO: handle different tags

            console.log(
                LOG_PREFIX,
                `Found ${elms.length} assets in ${outputPath} from template ${inputPath}`
            )
            await Promise.all(
                elms.map(async (img) => {
                    const src = img.getAttribute('src')
                    if (
                        isRelative(src) &&
                        pm.isMatch(src, pluginOptions.assetsMatching, {
                            contains: true
                        })
                    ) {
                        const assetPath = path.join(templateDir, src)
                        const assetSubdir = path.relative(
                            templateDir,
                            path.dirname(assetPath)
                        )
                        const assetBasename = path.basename(assetPath)

                        let destDir = path.join(outputDir, assetSubdir)
                        let destPath = path.join(destDir, assetBasename)
                        let destPathRelativeToPage = path.join(
                            './',
                            assetSubdir,
                            assetBasename
                        )

                        // resolve asset
                        if (await resolveFile(assetPath)) {
                            // calculate hash
                            if (pluginOptions.hashAssets) {
                                const hash = await hashFile(
                                    assetPath,
                                    pluginOptions.hashingAlg,
                                    pluginOptions.hashingDigest
                                )
                                if (pluginOptions.addIntegrityAttribute)
                                    img.setAttribute(
                                        'integrity',
                                        `${pluginOptions.hashingAlg}-${hash}`
                                    )

                                // rewrite paths
                                destDir = outputDir // flatten subdir
                                destPath = path.join(
                                    destDir,
                                    hash + path.extname(assetBasename)
                                )
                                destPathRelativeToPage =
                                    './' +
                                    path.join(
                                        hash + path.extname(assetBasename)
                                    )
                                img.setAttribute('src', destPathRelativeToPage)
                            }

                            await fs.mkdir(destDir, { recursive: true })
                            await copyFileIfNeeded(assetPath, destPath);
                        } else {
                            throw new Error(
                                `${LOG_PREFIX} Cannot resolve asset "${src}" in "${outputPath}" from template "${inputPath}"!`
                            )
                        }
                    }
                })
            )

            if (!pluginOptions.silent) {
                console.log(
                    LOG_PREFIX,
                    `Processed ${elms.length} images in "${outputPath}" from template "${inputPath}"`
                )
            }
            content = dom.serialize()
        }
    }
    return content
}

async function transformDirectoryWalker(content, outputPath) {
    const template = this
    if (outputPath && outputPath.endsWith('.html')) {
        const inputPath = template.inputPath

        if (
            pm.isMatch(inputPath, pluginOptions.postsMatching, {
                contains: true
            })
        ) {
            const templateDir = path.dirname(template.inputPath)
            const outputDir = path.dirname(outputPath)

            let assets = []
            if (pluginOptions.recursive) {
                for await (const file of walk(templateDir)) {
                    assets.push(file)
                }
            } else {
                assets = await fs.promises.readdir(templateDir)
                assets = assets.map((f) => path.join(templateDir, f))
            }
            assets = assets.filter((file) =>
                pm.isMatch(file, pluginOptions.assetsMatching, {
                    contains: true
                })
            )

            if (assets.length) {
                for (file of assets) {
                    const relativeSubDir = path.relative(
                        templateDir,
                        path.dirname(file)
                    )
                    const basename = path.basename(file)

                    const from = file
                    const destDir = path.join(outputDir, relativeSubDir)
                    const dest = path.join(destDir, basename)

                    await fs.mkdir(destDir, { recursive: true })
                    await copyFileIfNeeded(from, dest);
                }
            }
        }
    }
    return content
}

// export plugin
module.exports = {
    configFunction(eleventyConfig, options) {
        Object.assign(pluginOptions, options)

        if (pluginOptions.mode === 'parse') {
            // html parser
            eleventyConfig.addTransform(
                `${PREFIX}-transform-parser`,
                transformParser
            )
        } else if (pluginOptions.mode === 'directory') {
            // directory traverse
            eleventyConfig.addTransform(
                `${PREFIX}-transform-traverse`,
                transformDirectoryWalker
            )
        } else {
            throw new Error(
                `${LOG_PREFIX} Invalid mode! (${options.eleventyConfig}) Allowed modes: parse|directory`
            )
        }
    }
}
