/**
 * NW.js native USB implementation using the chrome.usb Chrome App API.
 * This provides a WebUSB-compatible interface backed by chrome.usb,
 * following the proven approach from the 10.10-maintenance branch.
 *
 * chrome.usb advantages over the `usb` npm package:
 * - Built into NW.js (no native addon compilation needed)
 * - Uses Chromium's USB stack (IOKit on macOS) directly
 * - No permission dialogs required
 * - Works on macOS ARM64 without entitlement issues
 */

const logHead = "[NWUSB]";

/**
 * Wraps a chrome.usb ConnectionHandle + device info to look like a WebUSB USBDevice.
 */
class NWUsbDevice {
    constructor(chromeDevice) {
        this._chromeDevice = chromeDevice;
        this._handle = null;

        this.vendorId = chromeDevice.vendorId;
        this.productId = chromeDevice.productId;
        this.productName = chromeDevice.productName || "DFU Device";
        this.manufacturerName = chromeDevice.manufacturerName || "";
        this.serialNumber = chromeDevice.serialNumber || `${chromeDevice.device}`;

        this.deviceVersionMajor = 0;
        this.deviceVersionMinor = 0;
        this.deviceVersionSubminor = 0;

        // Configuration info populated after open
        this.configuration = null;
    }

    async open() {
        return new Promise((resolve, reject) => {
            chrome.usb.openDevice(this._chromeDevice, (handle) => {
                if (chrome.runtime.lastError) {
                    reject(new Error(`Failed to open USB device: ${chrome.runtime.lastError.message}`));
                    return;
                }
                this._handle = handle;
                console.log(`${logHead} Device opened with Handle ID: ${handle.handle}`);

                // Populate configuration info
                this._populateConfiguration().then(resolve).catch(resolve);
            });
        });
    }

    async _populateConfiguration() {
        // Build a minimal configuration descriptor by reading from the device
        // This is needed for getInterfaceDescriptors in webusbdfu.js
        return new Promise((resolve) => {
            chrome.usb.listInterfaces(this._handle, (descriptors) => {
                if (chrome.runtime.lastError || !descriptors) {
                    console.warn(`${logHead} Could not list interfaces:`, chrome.runtime.lastError?.message);
                    this.configuration = { configurationValue: 1, interfaces: [] };
                    resolve();
                    return;
                }

                const interfaces = descriptors.map((desc) => ({
                    interfaceNumber: desc.interfaceNumber,
                    alternate: {
                        alternateSetting: desc.alternateSetting || 0,
                        interfaceClass: desc.interfaceClass,
                        interfaceSubclass: desc.interfaceSubclass,
                        interfaceProtocol: desc.interfaceProtocol,
                    },
                    alternates: desc.alternates
                        ? desc.alternates.map((alt) => ({
                            alternateSetting: alt.alternateSetting || 0,
                            interfaceClass: alt.interfaceClass,
                            interfaceSubclass: alt.interfaceSubclass,
                            interfaceProtocol: alt.interfaceProtocol,
                        }))
                        : [
                            {
                                alternateSetting: desc.alternateSetting || 0,
                                interfaceClass: desc.interfaceClass,
                                interfaceSubclass: desc.interfaceSubclass,
                                interfaceProtocol: desc.interfaceProtocol,
                            },
                        ],
                    claimed: false,
                }));

                this.configuration = { configurationValue: 1, interfaces };
                resolve();
            });
        });
    }

    async close() {
        if (!this._handle) {
            return;
        }
        return new Promise((resolve) => {
            chrome.usb.closeDevice(this._handle, () => {
                if (chrome.runtime.lastError) {
                    console.warn(`${logHead} Error closing device:`, chrome.runtime.lastError.message);
                }
                console.log(`${logHead} Device closed`);
                this._handle = null;
                resolve();
            });
        });
    }

    async selectConfiguration(configurationValue) {
        if (!this._handle) {
            throw new Error("Device not opened");
        }
        return new Promise((resolve, reject) => {
            chrome.usb.setConfiguration(this._handle, configurationValue, () => {
                if (chrome.runtime.lastError) {
                    reject(new Error(`selectConfiguration failed: ${chrome.runtime.lastError.message}`));
                    return;
                }
                resolve();
            });
        });
    }

    async claimInterface(interfaceNumber) {
        if (!this._handle) {
            throw new Error("Device not opened");
        }
        return new Promise((resolve, reject) => {
            chrome.usb.claimInterface(this._handle, interfaceNumber, () => {
                if (chrome.runtime.lastError) {
                    reject(new Error(`claimInterface failed: ${chrome.runtime.lastError.message}`));
                    return;
                }
                console.log(`${logHead} Claimed interface: ${interfaceNumber}`);
                resolve();
            });
        });
    }

    async releaseInterface(interfaceNumber) {
        if (!this._handle) {
            return;
        }
        return new Promise((resolve) => {
            chrome.usb.releaseInterface(this._handle, interfaceNumber, () => {
                if (chrome.runtime.lastError) {
                    console.warn(
                        `${logHead} Could not release interface: ${interfaceNumber}`,
                        chrome.runtime.lastError.message,
                    );
                } else {
                    console.log(`${logHead} Released interface: ${interfaceNumber}`);
                }
                resolve();
            });
        });
    }

    async controlTransferIn(setup, length) {
        if (!this._handle) {
            throw new Error("Device not opened");
        }
        return new Promise((resolve) => {
            chrome.usb.controlTransfer(
                this._handle,
                {
                    direction: "in",
                    recipient: setup.recipient,
                    requestType: setup.requestType,
                    request: setup.request,
                    value: setup.value,
                    index: setup.index,
                    length: length,
                },
                (result) => {
                    if (chrome.runtime.lastError) {
                        console.warn(`${logHead} controlTransferIn failed:`, chrome.runtime.lastError.message);
                        resolve({ status: "stall" });
                        return;
                    }
                    if (result.resultCode !== 0) {
                        resolve({ status: "stall" });
                        return;
                    }
                    const data = result.data
                        ? new DataView(new Uint8Array(result.data).buffer)
                        : new DataView(new ArrayBuffer(0));
                    resolve({ status: "ok", data });
                },
            );
        });
    }

    async controlTransferOut(setup, data) {
        if (!this._handle) {
            throw new Error("Device not opened");
        }
        return new Promise((resolve) => {
            const transferInfo = {
                direction: "out",
                recipient: setup.recipient,
                requestType: setup.requestType,
                request: setup.request,
                value: setup.value,
                index: setup.index,
            };

            if (data && data.byteLength > 0) {
                // chrome.usb expects ArrayBuffer
                transferInfo.data = data instanceof ArrayBuffer ? data : new Uint8Array(data).buffer;
            } else {
                transferInfo.data = new ArrayBuffer(0);
            }

            chrome.usb.controlTransfer(this._handle, transferInfo, (_result) => {
                if (chrome.runtime.lastError) {
                    console.warn(`${logHead} controlTransferOut failed:`, chrome.runtime.lastError.message);
                    resolve({ status: "stall", bytesWritten: 0 });
                    return;
                }
                resolve({ status: "ok", bytesWritten: data ? data.byteLength : 0 });
            });
        });
    }

    async reset() {
        if (!this._handle) {
            return;
        }
        return new Promise((resolve) => {
            chrome.usb.resetDevice(this._handle, (result) => {
                if (chrome.runtime.lastError) {
                    console.warn(`${logHead} Could not reset device:`, chrome.runtime.lastError.message);
                } else {
                    console.log(`${logHead} Reset Device: ${result}`);
                }
                resolve();
            });
        });
    }
}

/**
 * Provides a WebUSB-like interface (`navigator.usb`) backed by chrome.usb.
 * Supports getDevices(), requestDevice(), and connect/disconnect events.
 */
class NWUsbManager {
    constructor(filters) {
        this._filters = filters || [];
        this._listeners = { connect: [], disconnect: [] };
        this._knownDevices = [];
        this._pollInterval = null;

        this._startPolling();
    }

    _startPolling() {
        this._pollInterval = setInterval(() => this._pollDevices(), 2000);
    }

    _stopPolling() {
        if (this._pollInterval) {
            clearInterval(this._pollInterval);
            this._pollInterval = null;
        }
    }

    _matchesFilters(device) {
        if (this._filters.length === 0) {
            return true;
        }
        return this._filters.some((f) => f.vendorId === device.vendorId && f.productId === device.productId);
    }

    async _pollDevices() {
        try {
            const currentDevices = await this._getChromeDevices();
            const currentIds = currentDevices.map((d) => d.device);
            const knownIds = this._knownDevices.map((d) => d.device);

            // Detect newly added devices
            for (const device of currentDevices) {
                if (!knownIds.includes(device.device)) {
                    const nwDevice = new NWUsbDevice(device);
                    this._emit("connect", { device: nwDevice });
                }
            }

            // Detect removed devices
            for (const device of this._knownDevices) {
                if (!currentIds.includes(device.device)) {
                    const nwDevice = new NWUsbDevice(device);
                    this._emit("disconnect", { device: nwDevice });
                }
            }

            this._knownDevices = currentDevices;
        } catch (error) {
            console.warn(`${logHead} Error polling USB devices:`, error);
        }
    }

    _getChromeDevices() {
        return new Promise((resolve) => {
            chrome.usb.getDevices({ filters: this._filters }, (devices) => {
                if (chrome.runtime.lastError) {
                    console.warn(`${logHead} chrome.usb.getDevices error:`, chrome.runtime.lastError.message);
                    resolve([]);
                    return;
                }
                resolve(devices || []);
            });
        });
    }

    _emit(type, event) {
        const handlers = this._listeners[type] || [];
        for (const handler of handlers) {
            try {
                handler(event);
            } catch (e) {
                console.error(`${logHead} Event handler error:`, e);
            }
        }
    }

    addEventListener(type, handler) {
        if (!this._listeners[type]) {
            this._listeners[type] = [];
        }
        this._listeners[type].push(handler);
    }

    removeEventListener(type, handler) {
        if (this._listeners[type]) {
            this._listeners[type] = this._listeners[type].filter((h) => h !== handler);
        }
    }

    async getDevices() {
        const chromeDevices = await this._getChromeDevices();
        return chromeDevices.map((d) => new NWUsbDevice(d));
    }

    async requestDevice(options) {
        // In NW.js/chrome.usb, no permission dialog is needed.
        // Find the first device matching the filters.
        const filters = options?.filters || this._filters;
        return new Promise((resolve, reject) => {
            chrome.usb.getDevices({ filters }, (devices) => {
                if (chrome.runtime.lastError) {
                    reject(new Error(`requestDevice failed: ${chrome.runtime.lastError.message}`));
                    return;
                }
                if (!devices || devices.length === 0) {
                    reject(new Error("No device selected."));
                    return;
                }
                resolve(new NWUsbDevice(devices[0]));
            });
        });
    }
}

export default NWUsbManager;
