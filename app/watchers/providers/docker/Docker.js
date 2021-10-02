const fs = require('fs');
const Dockerode = require('dockerode');
const joi = require('joi-cron-expression')(require('joi'));
const cron = require('node-cron');
const parse = require('parse-docker-image-name');
const { parse: parseSemver, isGreater: isGreaterSemver } = require('../../../semver');
const event = require('../../../event');
const {
    wudWatch,
    wudTagInclude,
    wudTagExclude,
    wudWatchDigest,
    wudLinkTemplate,
} = require('./label');
const storeContainer = require('../../../store/container');
const log = require('../../../log');
const Component = require('../../../registry/Component');
const { validate: validateContainer, fullName } = require('../../../model/container');
const registry = require('../../../registry');
const { getWatchContainerGauge } = require('../../../prometheus/watcher');

/**
 * Return all supported registries
 * @returns {*}
 */
function getRegistries() {
    return registry.getState().registry;
}

/**
 * Filter candidate tags (based on tag name).
 * @param container
 * @param tags
 * @returns {*}
 */
function getTagCandidates(container, tags) {
    let filteredTags = tags;

    // Match include tag regex
    if (container.includeTags) {
        const includeTagsRegex = new RegExp(container.includeTags);
        filteredTags = filteredTags.filter((tag) => includeTagsRegex.test(tag));
    }

    // Match exclude tag regex
    if (container.excludeTags) {
        const excludeTagsRegex = new RegExp(container.excludeTags);
        filteredTags = filteredTags.filter((tag) => !excludeTagsRegex.test(tag));
    }

    // Semver image -> find higher semver tag
    if (container.image.tag.semver) {
        // Keep semver only
        filteredTags = filteredTags.filter((tag) => parseSemver(tag) !== null);

        // Keep only greater semver
        filteredTags = filteredTags
            .filter((tag) => isGreaterSemver(tag, container.image.tag.value));

        // Apply semver sort desc
        filteredTags.sort((t1, t2) => {
            const greater = isGreaterSemver(t2, t1);
            return greater ? 1 : -1;
        });
    } else {
        // Non semver tag -> do not propose any other registry tag
        filteredTags = [];
    }
    return filteredTags;
}

function normalizeContainer(container) {
    const containerWithNormalizedImage = container;
    const registryProvider = Object.values(getRegistries())
        .find((provider) => provider.match(container.image));
    if (!registryProvider) {
        log.warn(`${fullName(container)} - No Registry Provider found`);
        containerWithNormalizedImage.image.registry.name = 'unknown';
    } else {
        containerWithNormalizedImage.image = registryProvider.normalizeImage(container.image);
    }
    return validateContainer(containerWithNormalizedImage);
}

/**
 * Get the Docker Registry by name.
 * @param registryName
 */
function getRegistry(registryName) {
    const registryToReturn = getRegistries()[registryName];
    if (!registryToReturn) {
        throw new Error(`Unsupported Registry ${registryName}`);
    }
    return registryToReturn;
}

/**
 * Get old containers to prune.
 * @param newContainers
 * @param containersFromTheStore
 * @returns {*[]|*}
 */
function getOldContainers(newContainers, containersFromTheStore) {
    if (!containersFromTheStore || !newContainers) {
        return [];
    }
    return containersFromTheStore.filter((containerFromStore) => {
        const isContainerStillToWatch = newContainers
            .find((newContainer) => newContainer.id === containerFromStore.id);
        return isContainerStillToWatch === undefined;
    });
}

/**
 * Prune old containers from the store.
 * @param newContainers
 * @param containersFromTheStore
 */
function pruneOldContainers(newContainers, containersFromTheStore) {
    const containersToRemove = getOldContainers(newContainers, containersFromTheStore);
    containersToRemove.forEach((containerToRemove) => {
        storeContainer.deleteContainer(containerToRemove.id);
    });
}

function getContainerName(container) {
    let containerName;
    const names = container.Names;
    if (names && names.length > 0) {
        [containerName] = names;
    }
    // Strip ugly forward slash
    containerName = containerName.replace(/\//, '');
    return containerName;
}

/**
 * Get image repo digest.
 * @param containerImage
 * @returns {*} digest
 */
function getRepoDigest(containerImage) {
    if (!containerImage.RepoDigests || containerImage.RepoDigests.length === 0) {
        return undefined;
    }
    const fullDigest = containerImage.RepoDigests[0];
    const digestSplit = fullDigest.split('@');
    return digestSplit[1];
}

/**
 * Return true if container must be watched.
 * @param wudWatchLabelValue the value of the wud.watch label
 * @param watchByDefault true if containers must be watched by default
 * @returns {boolean}
 */
function isContainerToWatch(wudWatchLabelValue, watchByDefault) {
    return wudWatchLabelValue !== undefined && wudWatchLabelValue !== '' ? wudWatchLabelValue.toLowerCase() === 'true' : watchByDefault;
}

/**
 * Return true if container digest must be watched.
 * @param wudWatchDigestLabelValue the value of wud.watch.digest label
 * @param isSemver if image is semver
 * @returns {boolean|*}
 */
function isDigestToWatch(wudWatchDigestLabelValue, isSemver) {
    let result = false;
    if (isSemver) {
        if (wudWatchDigestLabelValue !== undefined && wudWatchDigestLabelValue !== '') {
            result = wudWatchDigestLabelValue.toLowerCase() === 'true';
        }
    } else {
        result = true;
        if (wudWatchDigestLabelValue !== undefined && wudWatchDigestLabelValue !== '') {
            result = wudWatchDigestLabelValue.toLowerCase() === 'true';
        }
    }
    return result;
}

/**
 * Docker Watcher Component.
 */
class Docker extends Component {
    getConfigurationSchema() {
        return joi.object().keys({
            socket: this.joi.string().default('/var/run/docker.sock'),
            host: this.joi.string(),
            port: this.joi.number().port().default(2375),
            cafile: this.joi.string(),
            certfile: this.joi.string(),
            keyfile: this.joi.string(),
            cron: joi.string().cron().default('0 * * * *'),
            watchbydefault: this.joi.boolean().default(true),
            watchall: this.joi.boolean().default(false),
            watchdigest: this.joi.any(),
        });
    }

    /**
     * Init the Watcher.
     */
    init() {
        this.initWatcher();
        if (this.configuration.watchdigest !== undefined) {
            this.log.warn('WUD_WATCHER_{watcher_name}_WATCHDIGEST environment variable is deprecated and won\'t be supported in upcoming versions');
        }
        this.log.info(`Cron scheduled (${this.configuration.cron})`);
        this.watchCron = cron.schedule(this.configuration.cron, () => this.watchFromCron());

        // watch at startup (after all components have been registered)
        setTimeout(() => this.watchFromCron(), 1000);
    }

    initWatcher() {
        const options = {};
        if (this.configuration.host) {
            options.host = this.configuration.host;
            options.port = this.configuration.port;
            if (this.configuration.cafile) {
                options.ca = fs.readFileSync(this.configuration.cafile);
            }
            if (this.configuration.certfile) {
                options.cert = fs.readFileSync(this.configuration.certfile);
            }
            if (this.configuration.keyfile) {
                options.key = fs.readFileSync(this.configuration.keyfile);
            }
        } else {
            options.socketPath = this.configuration.socket;
        }
        this.dockerApi = new Dockerode(options);
    }

    /**
     * Deregister the component.
     * @returns {Promise<void>}
     */
    async deregisterComponent() {
        if (this.watchCron) {
            this.watchCron.stop();
        }
    }

    /**
     * Watch containers (called by cron scheduled tasks).
     * @returns {Promise<*[]>}
     */
    async watchFromCron() {
        this.log.info(`Cron started (${this.configuration.cron})`);

        // Get container reports
        const containerReports = await this.watch();

        // Count container reports
        const containerReportsCount = containerReports.length;

        // Count container available updates
        const containerUpdatesCount = containerReports
            .filter((containerReport) => containerReport.container.updateAvailable).length;

        // Count container errors
        const containerErrorsCount = containerReports
            .filter((containerReport) => containerReport.container.error !== undefined).length;

        const stats = `${containerReportsCount} containers watched, ${containerErrorsCount} errors, ${containerUpdatesCount} available updates`;
        this.log.info(`Cron finished (${stats})`);
        return containerReports;
    }

    /**
     * Watch main method.
     * @returns {Promise<*[]>}
     */
    async watch() {
        let containers = [];

        // List images to watch
        try {
            containers = await this.getContainers();
        } catch (e) {
            this.log.warn(`Error when trying to get the list of the containers to watch (${e.message})`);
        }

        // Prune old containers from the store
        try {
            const containersFromTheStore = storeContainer.getContainers({ watcher: this.name });
            pruneOldContainers(containers, containersFromTheStore);
        } catch (e) {
            this.log.warn(`Error when trying to prune the old containers (${e.message})`);
        }
        getWatchContainerGauge().set({
            type: this.type,
            name: this.name,
        }, containers.length);

        try {
            const containerReports = await Promise.all(
                containers.map((container) => this.watchContainer(container)),
            );
            event.emitContainerReports(containerReports);
            return containerReports;
        } catch (e) {
            this.log.warn(`Error when processing some containers (${e.message})`);
            return [];
        }
    }

    /**
     * Watch a Container.
     * @param container
     * @returns {Promise<*>}
     */
    async watchContainer(container) {
        // Child logger for the container to process
        const logContainer = this.log.child({ container: fullName(container) });
        const containerWithResult = container;

        // Reset previous results if so
        delete containerWithResult.result;
        delete containerWithResult.error;
        logContainer.debug('Start watching');

        try {
            containerWithResult.result = await this.findNewVersion(container, logContainer);
        } catch (e) {
            logContainer.warn(`Error when processing (${e.message})`);
            logContainer.debug(e);
            containerWithResult.error = {
                message: e.message,
            };
        }

        const containerReport = this.mapContainerToContainerReport(containerWithResult);
        event.emitContainerReport(containerReport);
        return containerReport;
    }

    /**
     * Get all containers to watch.
     * @returns {Promise<unknown[]>}
     */
    async getContainers() {
        const listContainersOptions = {};
        if (this.configuration.watchall) {
            listContainersOptions.all = true;
        }
        const containers = await this.dockerApi.listContainers(listContainersOptions);

        // Filter on containers to watch
        const filteredContainers = containers
            .filter(
                (container) => isContainerToWatch(
                    container.Labels[wudWatch], this.configuration.watchbydefault,
                ),
            );
        const containerPromises = filteredContainers
            .map((container) => {
                const labels = container.Labels;
                const includeTags = labels[wudTagInclude] !== undefined
                    ? labels[wudTagInclude] : undefined;
                const excludeTags = labels[wudTagExclude] !== undefined
                    ? labels[wudTagExclude] : undefined;
                const linkTemplate = labels[wudLinkTemplate] !== undefined
                    ? labels[wudLinkTemplate] : undefined;
                return this.addImageDetailsToContainer(
                    container,
                    includeTags,
                    excludeTags,
                    linkTemplate,
                );
            });
        const containersWithImage = await Promise.all(containerPromises);

        // Return containers to process
        return containersWithImage.filter((imagePromise) => imagePromise !== undefined);
    }

    /**
     * Find new version for a Container.
     */

    /* eslint-disable-next-line */
    async findNewVersion(container, logContainer) {
        const registryProvider = getRegistry(container.image.registry.name);
        const result = { tag: container.image.tag.value };
        if (!registryProvider) {
            logContainer.error(`Unsupported registry (${container.image.registry.name})`);
        } else {
            // Must watch digest? => Find local/remote digests on registry
            if (container.image.digest.watch && container.image.digest.repo) {
                const remoteDigest = await registryProvider.getImageManifestDigest(container.image);
                result.digest = remoteDigest.digest;
                result.created = remoteDigest.created;

                if (remoteDigest.version === 2) {
                    // Regular v2 manifest => Get manifest digest
                    /*  eslint-disable no-param-reassign */
                    const digestV2 = await registryProvider.getImageManifestDigest(
                        container.image,
                        container.image.digest.repo,
                    );
                    container.image.digest.value = digestV2.digest;
                } else {
                    // Legacy v1 image => take Image digest as reference for comparison
                    const image = await this.dockerApi.getImage(container.image.id).inspect();
                    container.image.digest.value = image.Config.Image === '' ? undefined : image.Config.Image;
                }
            }

            const tags = await registryProvider.getTags(container.image);

            // Get candidates (based on tag name)
            const tagsCandidates = getTagCandidates(container, tags);

            // The first one in the array is the highest
            if (tagsCandidates && tagsCandidates.length > 0) {
                [result.tag] = tagsCandidates;
            }
            return result;
        }
    }

    /**
     * Add image detail to Container.
     * @param container
     * @param includeTags
     * @param excludeTags
     * @param linkTemplate
     * @returns {Promise<Image>}
     */
    async addImageDetailsToContainer(container, includeTags, excludeTags, linkTemplate) {
        const containerId = container.Id;

        // Is container already in store? just return it :)
        const containerInStore = storeContainer.getContainer(containerId);
        if (containerInStore !== undefined && containerInStore.error === undefined) {
            this.log.debug(`Container ${containerInStore.id} already in store`);
            return containerInStore;
        }

        // Get container image details
        const image = await this.dockerApi.getImage(container.Image).inspect();

        // Get useful properties
        const containerName = getContainerName(container);
        const status = container.State;
        const architecture = image.Architecture;
        const os = image.Os;
        const variant = image.Variant;
        const created = image.Created;
        const repoDigest = getRepoDigest(image);
        const imageId = image.Id;

        // Parse image to get registry, organization...
        let imageNameToParse = container.Image;
        if (imageNameToParse.includes('sha256:')) {
            if (!image.RepoTags || image.RepoTags.length === 0) {
                this.log.warn(`Cannot get a reliable tag for this image [${imageNameToParse}]`);
                return Promise.resolve();
            }
            // Get the first repo tag (better than nothing ;)
            [imageNameToParse] = image.RepoTags;
        }
        const parsedImage = parse(imageNameToParse);
        const tagName = parsedImage.tag || 'latest';
        const parsedTag = parseSemver(tagName);
        const isSemver = parsedTag !== null && parsedTag !== undefined;
        const watchDigest = isDigestToWatch(
            container.Labels[wudWatchDigest],
            isSemver,
        );
        if (!isSemver && !watchDigest) {
            this.log.warn('Image is not a semver and digest watching is disabled so wud won\'t report any update. Please review the configuration to enable digest watching for this container or exclude this container from being watched');
        }
        return normalizeContainer({
            id: containerId,
            name: containerName,
            status,
            watcher: this.name,
            includeTags,
            excludeTags,
            linkTemplate,
            image: {
                id: imageId,
                registry: {
                    url: parsedImage.domain,
                },
                name: parsedImage.path,
                tag: {
                    value: tagName,
                    semver: isSemver,
                },
                digest: {
                    watch: watchDigest,
                    repo: repoDigest,
                },
                architecture,
                os,
                variant,
                created,
            },
            result: {
                tag: tagName,
            },
        });
    }

    /**
     * Process a Container with result and map to a containerReport.
     * @param containerWithResult
     * @return {*}
     */
    mapContainerToContainerReport(containerWithResult) {
        const logContainer = this.log.child({ container: fullName(containerWithResult) });
        const containerReport = {
            container: containerWithResult,
            changed: false,
        };

        // Find container in db & compare
        const containerInDb = storeContainer.getContainer(containerWithResult.id);

        // Not found in DB? => Save it
        if (!containerInDb) {
            logContainer.debug('Container watched for the first time');
            containerReport.container = storeContainer.insertContainer(containerWithResult);
            containerReport.changed = true;

        // Found in DB? => update it
        } else {
            containerReport.container = storeContainer.updateContainer(containerWithResult);
            containerReport.changed = containerInDb.resultChanged(containerReport.container)
                && containerWithResult.updateAvailable;
        }
        return containerReport;
    }
}

module.exports = Docker;
