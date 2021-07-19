import type { DefaultEvents } from 'nanoevents';
import { createNanoEvents } from 'nanoevents';
import type { WatchStopHandle } from 'vue';
import { watch } from 'vue';
import type { AsyncHandler, Frame, Options, PostObject, Mode, Promises, Context, Type } from './types';

const register: Record<string, Context<DefaultEvents>> = {};
const handlers: Record<string, AsyncHandler> = {};
const promises: Promises = {};

const generateId = () => Math.floor(Math.random() * 1000000) + 1;

const processMessage = async (e: MessageEvent<PostObject>) => {
    if (
        !e.data ||
        !e.data.id ||
        !register[e.data.id] ||

        /**
         * Check the origin, if one was supplied.
         * Sandboxed iFrames without the `allow-same-origin` permission
         * will return `"null"` as an origin, so in that case we cannot
         * enforce it.
         */
        (
            (register[e.data.id].remote ?? '*') !== '*' &&
            e.origin !== 'null' &&
            !e.origin.startsWith(register[e.data.id].remote as string)
        ) ||

        // If this is the Host, ensure the source is the iFrame Element.
        (
            register[e.data.id].mode === 'host' &&
            e.source !== register[e.data.id].iframe?.value?.contentWindow
        )
    ) {
        return;
    }

    const { id, type, payload } = e.data;
    const { events, post } = register[id];

    if (type === '_async') {
        // Process incoming async executions.
        let response: Error|unknown;

        try {
            if (!handlers[payload.type]) {
                throw new Error(`No Handler for Event "${payload.type}"`);
            }

            response = await handlers[payload.type](payload.message);
        } catch (e) {
            response = e;
        }

        post('_asyncResponse', {
            id: payload.id,
            response,
        });
    } else if (type === '_asyncResponse') {
        /**
         * Process the response from async executions.
         * This just means taking the response and resolving/rejecting
         * the stored promise.
         */
        const promise = promises[payload.id];

        if (promise) {
            window.clearTimeout(promise.timeout);

            if (payload.response instanceof Error) {
                promise.reject(payload.response);
            } else {
                promise.resolve(payload.response);
            }

            delete promises[payload.id];
        }
    } else {
        // Otherwise it's a regular event, so emit it to any listeners.
        events.emit(type, payload);
    }
};

export function useEmbed<E extends DefaultEvents>(mode: Mode, options: Options) {
    if (register[options.id]) {
        return register[options.id];
    }

    const events = createNanoEvents<E>();
    const isHost = mode === 'host';
    let target: Window|null = window.parent;
    let watcher: WatchStopHandle|undefined;

    const post = (type: Type, message?: any) => {
        if (!target) {
            throw new Error('Target Window is unloaded');
        }

        target?.postMessage({
            id: options.id,
            type,
            payload: message ?? {},
        }, target?.origin !== 'null' ? (options.remote ?? '*') : '*');
    };

    const send = async (type: Type, message?: any) => {
        return new Promise((resolve, reject) => {
            const id = generateId();

            promises[id] = {
                resolve,
                reject,
                timeout: window.setTimeout(() => {
                    reject(new Error('Timed out'));
                    delete promises[id];
                }, options.timeout ?? 15000),
            };

            post('_async', {
                id,
                type,
                message: message ?? {},
            });
        });
    };

    const handle = <P = any>(type: Type, callback: AsyncHandler<P>) => {
        handlers[type] = callback;

        return () => {
            delete handlers[type];
        };
    };

    if (isHost) {
        watcher = watch(options.iframe as Frame, frame => {
            if (frame?.contentWindow) {
                target = frame.contentWindow;
            }
        }, { immediate: true });
    }

    const destroy = () => {
        if (watcher) {
            watcher();
        }

        register[options.id].events.events = {};
        delete register[options.id];

        if (!Object.keys(register).length) {
            window.removeEventListener('message', processMessage);
        }
    };

    const context: Context<E> = {
        mode,
        post,
        send,
        handle,
        destroy,
        events,
        iframe: options.iframe,
        remote: options.remote,
    };

    register[options.id] = context;

    if (Object.keys(register).length === 1) {
        window.addEventListener('message', processMessage);
    }

    return context;
}

export * from './types';
