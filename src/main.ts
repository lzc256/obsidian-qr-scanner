import {
	App,
	Modal,
	Editor,
	Plugin,
	PluginSettingTab,
	Setting,
	Notice,
	Platform,
} from "obsidian";
import { Html5Qrcode, Html5QrcodeSupportedFormats } from "html5-qrcode";

interface QrScannerSettings {
	playSound: boolean;
}

const DEFAULT_SETTINGS: QrScannerSettings = {
	playSound: true,
};

export default class QrScannerPlugin extends Plugin {
	settings: QrScannerSettings;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new QrScannerSettingTab(this.app, this));

		this.addCommand({
			id: "open-qr-scanner",
			name: "Scan QR/Barcode and Insert",
			icon: "qr-code",
			editorCallback: (editor: Editor) => {
				new ScannerModal(this.app, editor, this.settings).open();
			},
		});
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData(),
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class ScannerModal extends Modal {
	editor: Editor;
	settings: QrScannerSettings;
	html5QrCode: Html5Qrcode | null = null;
	beepAudio = new Audio(
		"data:audio/wav;base64,UklGRl9vT19XQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YTtvT18=",
	);
	private processingCanvas: HTMLCanvasElement | null = null;

	constructor(app: App, editor: Editor, settings: QrScannerSettings) {
		super(app);
		this.editor = editor;
		this.settings = settings;
	}

	async onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "Scan Code" });

		contentEl.createEl("div", {
			attr: { id: "reader", style: "display:none;" },
		});

		this.html5QrCode = new Html5Qrcode("reader", {
			verbose: false,
			formatsToSupport: [
				Html5QrcodeSupportedFormats.QR_CODE,
				Html5QrcodeSupportedFormats.DATA_MATRIX,
				Html5QrcodeSupportedFormats.EAN_13,
				Html5QrcodeSupportedFormats.CODE_128,
				Html5QrcodeSupportedFormats.UPC_A,
			],
		});

		if (Platform.isMobile) {
			this.renderMobileUI(contentEl);
		} else {
			this.renderDesktopUI(contentEl);
		}
	}

	renderMobileUI(contentEl: HTMLElement) {
		const container = contentEl.createEl("div", {
			attr: {
				style: "display: flex; flex-direction: column; align-items: center; justify-content: center; height: 150px;",
			},
		});

		const statusText = container.createEl("p", {
			text: "Opening system camera...",
		});

		const fileInput = container.createEl("input", {
			attr: {
				type: "file",
				accept: "image/*",
				capture: "environment",
				style: "display: none;",
			},
		});

		fileInput.onchange = async (e: Event) => {
			const file = (e.target as HTMLInputElement).files?.[0];
			if (!file || !this.html5QrCode) {
				this.close();
				return;
			}

			statusText.setText("High-precision processing...");
			try {
				const optimizedFile = await this.preprocessImage(file);
				const result = await this.html5QrCode.scanFile(
					optimizedFile,
					false,
				);
				this.handleSuccess(result);
			} catch (err) {
				try {
					const rawResult = await this.html5QrCode.scanFile(
						file,
						true,
					);
					this.handleSuccess(rawResult);
				} catch (innerErr) {
					new Notice("Scan failed. Ensure focus on the matrix.");
					this.close();
				}
			}
		};

		setTimeout(() => fileInput.click(), 150);
	}

	private async preprocessImage(file: File): Promise<File> {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = (e) => {
				const img = new Image();
				img.onload = () => {
					if (!this.processingCanvas)
						this.processingCanvas =
							document.createElement("canvas");
					const canvas = this.processingCanvas;
					const ctx = canvas.getContext("2d", {
						willReadFrequently: true,
					});
					if (!ctx) return reject("Canvas error");

					const TARGET_WIDTH = 1600;
					const scale =
						img.width > TARGET_WIDTH ? TARGET_WIDTH / img.width : 1;
					const PADDING = 40;

					canvas.width = img.width * scale + PADDING * 2;
					canvas.height = img.height * scale + PADDING * 2;

					ctx.fillStyle = "#FFFFFF";
					ctx.fillRect(0, 0, canvas.width, canvas.height);

					ctx.imageSmoothingEnabled = true;
					ctx.imageSmoothingQuality = "high";
					ctx.drawImage(
						img,
						PADDING,
						PADDING,
						img.width * scale,
						img.height * scale,
					);

					const imageData = ctx.getImageData(
						0,
						0,
						canvas.width,
						canvas.height,
					);
					const data = imageData.data;

					for (let i = 0; i < data.length; i += 4) {
						const r = data[i] ?? 0;
						const g = data[i + 1] ?? 0;
						const b = data[i + 2] ?? 0;

						// Standard grayscale to preserve sub-pixel edges for Matrix codes
						const gray = r * 0.299 + g * 0.587 + b * 0.114;

						data[i] = data[i + 1] = data[i + 2] = gray;
					}
					ctx.putImageData(imageData, 0, 0);

					canvas.toBlob(
						(blob) => {
							if (blob) {
								resolve(
									new File([blob], file.name, {
										type: "image/jpeg",
									}),
								);
							} else {
								reject("Blob error");
							}
						},
						"image/jpeg",
						0.95,
					);
				};
				img.src = e.target?.result as string;
			};
			reader.readAsDataURL(file);
		});
	}

	async renderDesktopUI(contentEl: HTMLElement) {
		const readerDiv = document.getElementById("reader");
		if (!readerDiv) return;

		readerDiv.style.display = "block";
		readerDiv.style.minHeight = "300px";
		readerDiv.style.borderRadius = "8px";
		readerDiv.style.overflow = "hidden";

		const statusText = contentEl.createEl("p", {
			text: "Starting camera...",
			attr: { style: "text-align:center; margin-top:10px;" },
		});

		try {
			await this.html5QrCode!.start(
				{ facingMode: "environment" },
				{ fps: 15, qrbox: { width: 250, height: 250 } },
				(text) => this.handleSuccess(text),
				() => {},
			);
			statusText.setText("Point camera at Data Matrix or QR");
		} catch (err) {
			statusText.setText("Camera access failed: " + err);
			statusText.style.color = "var(--text-error)";
		}
	}

	handleSuccess(decodedText: string) {
		if (this.settings.playSound) {
			this.beepAudio.play().catch(() => {});
		}
		this.editor.replaceSelection(decodedText);
		new Notice("Scan successful!");
		this.stopAndClose();
	}

	async stopAndClose() {
		if (this.html5QrCode) {
			if (this.html5QrCode.isScanning) await this.html5QrCode.stop();
			this.html5QrCode.clear();
		}
		this.close();
	}

	onClose() {
		this.stopAndClose();
		this.contentEl.empty();
	}
}

class QrScannerSettingTab extends PluginSettingTab {
	plugin: QrScannerPlugin;

	constructor(app: App, plugin: QrScannerPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: "QR Scanner Settings" });

		new Setting(containerEl)
			.setName("Beep Sound")
			.setDesc("Play a sound on successful scan")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.playSound)
					.onChange(async (value) => {
						this.plugin.settings.playSound = value;
						await this.plugin.saveSettings();
					}),
			);
	}
}
