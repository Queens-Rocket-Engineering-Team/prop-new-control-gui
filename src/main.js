import { createApp } from "vue";
import App from "./App.vue";
import PrimeVue from 'primevue/config';
import Aura from '@primeuix/themes/aura';
import '@fontsource/inter';
import { isWeb } from './lib/platform.js';
import { setInjectedServerIp } from './lib/desktop.js';

// The web build is served by a container that writes config.json at startup
// from its environment, so one image works against any server. Missing or
// unparseable config is fine — desktop.js then falls back to the host that
// served the page, which is correct whenever the GUI runs alongside the server.
async function loadRuntimeConfig() {
    if (!isWeb()) return;
    try {
        const res = await fetch('./config.json', { cache: 'no-store' });
        if (!res.ok) return;
        const config = await res.json();
        setInjectedServerIp(config?.serverIp ?? '');
    } catch {
        /* no runtime config — fall back to the serving host */
    }
}

const app = createApp(App);
app.use(PrimeVue, {
    theme: {
        preset: Aura,
        options: {
            prefix: 'p',
            darkModeSelector: '.dark-mode',
            cssLayer: false,
        }
    }
});

// Config must be in place before App.vue's onMounted resolves the server IP.
loadRuntimeConfig().finally(() => app.mount("#app"));