const events = require('events');

// Build EventEmitter
const eventEmitter = new events.EventEmitter();

const WUD_CONTAINER_ADDED = 'wud:container-added';
const WUD_CONTAINER_UPDATED = 'wud:container-updated';
const WUD_CONTAINER_REMOVED = 'wud:container-removed';
const WUD_CONTAINER_REPORT = 'wud:container-report';
const WUD_CONTAINER_REPORTS = 'wud:container-reports';

/**
 * Emit ContainerReports event.
 * @param containerReports
 */
function emitContainerReports(containerReports) {
    eventEmitter.emit(WUD_CONTAINER_REPORTS, containerReports);
}

/**
 * Register to ContainersResult event.
 * @param handler
 */
function registerContainerReports(handler) {
    eventEmitter.on(WUD_CONTAINER_REPORTS, handler);
}

/**
 * Emit ContainerReport event.
 * @param containerReport
 */
function emitContainerReport(containerReport) {
    eventEmitter.emit(WUD_CONTAINER_REPORT, containerReport);
}

/**
 * Register to ContainerReport event.
 * @param handler
 */
function registerContainerReport(handler) {
    eventEmitter.on(WUD_CONTAINER_REPORT, handler);
}

/**
 * Emit container added.
 * @param containerAdded
 */
function emitContainerAdded(containerAdded) {
    eventEmitter.emit(WUD_CONTAINER_ADDED, containerAdded);
}

/**
 * Register to container added event.
 * @param handler
 */
function registerContainerAdded(handler) {
    eventEmitter.on(WUD_CONTAINER_ADDED, handler);
}

/**
 * Emit container added.
 * @param containerUpdated
 */
function emitContainerUpdated(containerUpdated) {
    eventEmitter.emit(WUD_CONTAINER_UPDATED, containerUpdated);
}

/**
 * Register to container updated event.
 * @param handler
 */
function registerContainerUpdated(handler) {
    eventEmitter.on(WUD_CONTAINER_UPDATED, handler);
}

/**
 * Emit container removed.
 * @param containerRemoved
 */
function emitContainerRemoved(containerRemoved) {
    eventEmitter.emit(WUD_CONTAINER_REMOVED, containerRemoved);
}

/**
 * Register to container removed event.
 * @param handler
 */
function registerContainerRemoved(handler) {
    eventEmitter.on(WUD_CONTAINER_REMOVED, handler);
}

module.exports = {
    emitContainerReports,
    registerContainerReports,
    emitContainerReport,
    registerContainerReport,
    emitContainerAdded,
    registerContainerAdded,
    emitContainerUpdated,
    registerContainerUpdated,
    emitContainerRemoved,
    registerContainerRemoved,
};
