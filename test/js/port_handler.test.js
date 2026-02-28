import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock dependencies before importing port_handler
vi.mock("../../src/js/ConfigStorage", () => ({
    get: vi.fn((key, defaultValue) => ({ [key]: defaultValue })),
}));

vi.mock("../../src/components/eventBus", () => ({
    EventBus: {
        $on: vi.fn(),
        $emit: vi.fn(),
    },
}));

vi.mock("../../src/js/serial.js", () => ({
    serial: {
        connected: false,
        getConnectedPort: vi.fn(),
        addEventListener: vi.fn(),
        getDevices: vi.fn().mockResolvedValue([]),
    },
}));

vi.mock("../../src/js/protocols/webusbdfu", () => ({
    default: {
        usbDevice: null,
        getConnectedPort: vi.fn(),
        addEventListener: vi.fn(),
        getDevices: vi.fn().mockResolvedValue([]),
    },
}));

vi.mock("../../src/js/utils/checkCompatibility.js", () => ({
    checkCompatibility: vi.fn(),
    checkBluetoothSupport: vi.fn(() => false),
    checkSerialSupport: vi.fn(() => true),
    checkUsbSupport: vi.fn(() => false),
}));

vi.mock("vue", () => ({
    reactive: (obj) => obj,
}));

const { default: PortHandler } = await import("../../src/js/port_handler.js");

describe("PortHandler", () => {
    describe("selectActivePort", () => {
        beforeEach(() => {
            PortHandler.currentSerialPorts = [];
            PortHandler.currentUsbPorts = [];
            PortHandler.currentBluetoothPorts = [];
            PortHandler.showVirtualMode = false;
            PortHandler.showManualMode = false;
        });

        it("selects STM Electronics device by display name", () => {
            PortHandler.currentSerialPorts = [{ path: "COM3", displayName: "Betaflight STM Electronics" }];
            const result = PortHandler.selectActivePort();
            expect(result).toBe("COM3");
        });

        it("selects AT32 device by display name", () => {
            PortHandler.currentSerialPorts = [{ path: "COM4", displayName: "Betaflight AT32" }];
            const result = PortHandler.selectActivePort();
            expect(result).toBe("COM4");
        });

        it("selects Silicon Labs (CP210x) device by display name", () => {
            PortHandler.currentSerialPorts = [{ path: "COM5", displayName: "Betaflight Silicon Labs" }];
            const result = PortHandler.selectActivePort();
            expect(result).toBe("COM5");
        });

        it("selects device with CP210 in display name (legacy)", () => {
            PortHandler.currentSerialPorts = [{ path: "COM6", displayName: "CP210x USB to UART Bridge" }];
            const result = PortHandler.selectActivePort();
            expect(result).toBe("COM6");
        });

        it("selects Geehy (APM32) device by display name", () => {
            PortHandler.currentSerialPorts = [{ path: "COM7", displayName: "Betaflight Geehy Semiconductor" }];
            const result = PortHandler.selectActivePort();
            expect(result).toBe("COM7");
        });

        it("selects Raspberry Pi Pico device by display name", () => {
            PortHandler.currentSerialPorts = [{ path: "COM8", displayName: "Betaflight Raspberry Pi Pico" }];
            const result = PortHandler.selectActivePort();
            expect(result).toBe("COM8");
        });

        it("selects SPR (SpeedyBee) device by display name", () => {
            PortHandler.currentSerialPorts = [{ path: "COM9", displayName: "SPRacing device" }];
            const result = PortHandler.selectActivePort();
            expect(result).toBe("COM9");
        });

        it("returns default when no recognized device is present", () => {
            PortHandler.currentSerialPorts = [{ path: "COM1", displayName: "Unknown Device" }];
            const result = PortHandler.selectActivePort();
            expect(result).toBeUndefined();
            expect(PortHandler.portPicker.selectedPort).toBe("noselection");
        });

        it("prefers suggested device over filter match", () => {
            PortHandler.currentSerialPorts = [{ path: "COM3", displayName: "Betaflight STM Electronics" }];
            const suggestedDevice = { path: "COM10" };
            const result = PortHandler.selectActivePort(suggestedDevice);
            expect(result).toBe("COM10");
        });

        it("returns virtual port when showVirtualMode is enabled and no device found", () => {
            PortHandler.showVirtualMode = true;
            const result = PortHandler.selectActivePort();
            expect(result).toBe("virtual");
        });

        it("returns manual port when showManualMode is enabled and no device found", () => {
            PortHandler.showManualMode = true;
            const result = PortHandler.selectActivePort();
            expect(result).toBe("manual");
        });
    });
});
