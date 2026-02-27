import { serialDevices, vendorIdNames } from "./devices";

const logHead = "[NWSERIAL]";

/**
 * NW.js native serial port implementation using the Node.js serialport module.
 * This replaces WebSerial when running inside NW.js desktop builds,
 * providing direct native USB serial access without browser permission prompts.
 */
class NWSerial extends EventTarget {
    constructor() {
        super();

        this.connected = false;
        this.openRequested = false;
        this.openCanceled = false;
        this.closeRequested = false;
        this.transmitting = false;
        this.connectionInfo = null;

        this.bitrate = 0;
        this.bytesSent = 0;
        this.bytesReceived = 0;
        this.failed = 0;

        this.ports = [];
        this.port = null;
        this.reading = false;
        this._SerialPort = null;
        this._pollInterval = null;
        this.available = false;

        this.connect = this.connect.bind(this);
        this.disconnect = this.disconnect.bind(this);
        this.handleReceiveBytes = this.handleReceiveBytes.bind(this);

        // Load serialport module via NW.js Node.js context
        try {
            const sp = globalThis.nw.require("serialport");
            this._SerialPort = sp.SerialPort;
            this.available = true;
            console.log(`${logHead} Native serial module loaded successfully`);
        } catch (error) {
            console.warn(`${logHead} Failed to load serialport module:`, error);
            this.available = false;
            return;
        }

        this.loadDevices();
        this._startDevicePolling();
    }

    _startDevicePolling() {
        this._pollInterval = setInterval(() => this._pollDevices(), 2000);
    }

    _stopDevicePolling() {
        if (this._pollInterval) {
            clearInterval(this._pollInterval);
            this._pollInterval = null;
        }
    }

    async _pollDevices() {
        if (!this._SerialPort) {
            return;
        }

        try {
            const systemPorts = await this._SerialPort.list();
            const currentPaths = systemPorts.map((p) => p.path);
            const knownPaths = this.ports.map((p) => p.path);

            // Detect newly added devices
            for (const portInfo of systemPorts) {
                if (!knownPaths.includes(portInfo.path)) {
                    const added = this._createPort(portInfo);
                    this.ports.push(added);
                    this.dispatchEvent(new CustomEvent("addedDevice", { detail: added }));
                }
            }

            // Detect removed devices
            for (const port of [...this.ports]) {
                if (!currentPaths.includes(port.path)) {
                    this.ports = this.ports.filter((p) => p.path !== port.path);
                    this.dispatchEvent(new CustomEvent("removedDevice", { detail: port }));
                }
            }
        } catch (error) {
            console.warn(`${logHead} Error polling devices:`, error);
        }
    }

    _createPort(portInfo) {
        const vendorId = portInfo.vendorId ? parseInt(portInfo.vendorId, 16) : undefined;
        const productId = portInfo.productId ? parseInt(portInfo.productId, 16) : undefined;

        let displayName;
        if (vendorId && vendorIdNames[vendorId]) {
            displayName = vendorIdNames[vendorId];
        } else if (portInfo.manufacturer) {
            displayName = portInfo.manufacturer;
        } else {
            displayName = portInfo.path;
        }

        return {
            path: portInfo.path,
            displayName: `Betaflight ${displayName}`,
            vendorId: vendorId,
            productId: productId,
            port: portInfo,
        };
    }

    handleReceiveBytes(info) {
        this.bytesReceived += info.detail.byteLength;
    }

    getConnectedPort() {
        return this.ports.find((p) => p.path === this.connectionId) || null;
    }

    async loadDevices() {
        if (!this._SerialPort) {
            return;
        }

        try {
            const systemPorts = await this._SerialPort.list();
            this.ports = systemPorts.map((portInfo) => this._createPort(portInfo));
        } catch (error) {
            console.error(`${logHead} Error loading devices:`, error);
        }
    }

    async requestPermissionDevice() {
        // Native serial does not require permission prompts
        await this.loadDevices();

        // Return first port matching known flight controller VID/PIDs
        const knownDevice = this.ports.find((p) =>
            serialDevices.some((d) => d.vendorId === p.vendorId && d.productId === p.productId),
        );

        return knownDevice || (this.ports.length > 0 ? this.ports[0] : null);
    }

    async getDevices() {
        await this.loadDevices();
        return this.ports;
    }

    async connect(path, options = { baudRate: 115200 }) {
        if (this.connected) {
            console.log(`${logHead} Already connected`);
            return true;
        }

        this.openRequested = true;
        this.closeRequested = false;

        try {
            const device = this.ports.find((d) => d.path === path);
            if (!device) {
                console.error(`${logHead} Device not found:`, path);
                this.dispatchEvent(new CustomEvent("connect", { detail: false }));
                return false;
            }

            return new Promise((resolve) => {
                this.port = new this._SerialPort({
                    path: path,
                    baudRate: options.baudRate,
                    autoOpen: false,
                });

                this.port.open((err) => {
                    if (err) {
                        console.error(`${logHead} Error opening port:`, err);
                        this.openRequested = false;
                        this.port = null;
                        this.dispatchEvent(new CustomEvent("connect", { detail: false }));
                        resolve(false);
                        return;
                    }

                    if (this.openCanceled) {
                        this.openRequested = false;
                        this.openCanceled = false;
                        this.port.close(() => {
                            this.port = null;
                            this.dispatchEvent(new CustomEvent("connect", { detail: false }));
                        });
                        resolve(false);
                        return;
                    }

                    this.connected = true;
                    this.connectionId = path;
                    this.bitrate = options.baudRate;
                    this.bytesReceived = 0;
                    this.bytesSent = 0;
                    this.failed = 0;
                    this.openRequested = false;
                    this.reading = true;

                    this.connectionInfo = {
                        usbVendorId: device.vendorId,
                        usbProductId: device.productId,
                    };

                    // Set up data handler
                    this.port.on("data", (data) => {
                        if (this.reading) {
                            const uint8 = new Uint8Array(data);
                            this.dispatchEvent(new CustomEvent("receive", { detail: uint8 }));
                        }
                    });

                    this.port.on("error", (portErr) => {
                        console.error(`${logHead} Serial port error:`, portErr);
                        if (this.connected) {
                            this.disconnect();
                        }
                    });

                    this.port.on("close", () => {
                        if (this.connected) {
                            console.log(`${logHead} Port closed unexpectedly`);
                            this.disconnect();
                        }
                    });

                    this.addEventListener("receive", this.handleReceiveBytes);

                    console.log(
                        `${logHead} Connection opened with ID: ${this.connectionId}, Baud: ${options.baudRate}`,
                    );
                    this.dispatchEvent(new CustomEvent("connect", { detail: this.connectionInfo }));
                    resolve(true);
                });
            });
        } catch (error) {
            console.error(`${logHead} Error connecting:`, error);
            this.openRequested = false;
            this.dispatchEvent(new CustomEvent("connect", { detail: false }));
            return false;
        }
    }

    async disconnect() {
        if (!this.connected) {
            return true;
        }

        this.connected = false;
        this.transmitting = false;
        this.reading = false;

        if (this.closeRequested) {
            return true;
        }

        this.closeRequested = true;

        try {
            this.removeEventListener("receive", this.handleReceiveBytes);

            if (this.port && this.port.isOpen) {
                await new Promise((resolve) => {
                    this.port.close((err) => {
                        if (err) {
                            console.warn(`${logHead} Error closing port:`, err);
                        }
                        resolve();
                    });
                });
            }

            console.log(
                `${logHead} Connection with ID: ${this.connectionId} closed, Sent: ${this.bytesSent} bytes, Received: ${this.bytesReceived} bytes`,
            );

            this.port = null;
            this.connectionId = false;
            this.bitrate = 0;
            this.connectionInfo = null;
            this.closeRequested = false;

            this.dispatchEvent(new CustomEvent("disconnect", { detail: true }));
            return true;
        } catch (error) {
            console.error(`${logHead} Error disconnecting:`, error);
            this.closeRequested = false;
            this.connectionInfo = null;
            this.dispatchEvent(new CustomEvent("disconnect", { detail: false }));
            return false;
        } finally {
            if (this.openCanceled) {
                this.openCanceled = false;
            }
        }
    }

    async send(data, callback) {
        if (!this.connected || !this.port) {
            console.error(`${logHead} Failed to send data, serial port not open`);
            const result = { bytesSent: 0 };
            if (callback) {
                callback(result);
            }
            return result;
        }

        try {
            const buffer = Buffer.from(data);
            await new Promise((resolve, reject) => {
                this.port.write(buffer, (err) => {
                    if (err) {
                        reject(err);
                    } else {
                        this.port.drain(resolve);
                    }
                });
            });

            this.bytesSent += data.byteLength;
            const result = { bytesSent: data.byteLength };
            if (callback) {
                callback(result);
            }
            return result;
        } catch (error) {
            console.error(`${logHead} Error sending data:`, error);
            const result = { bytesSent: 0 };
            if (callback) {
                callback(result);
            }
            return result;
        }
    }
}

export default NWSerial;
