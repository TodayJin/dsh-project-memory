/**
 * Render test for the browser half.
 *
 * The settings page and the composer chip are plain functions once React is
 * stubbed, so they can be called directly here. That is the point: a component
 * that references a variable it never declared throws a ReferenceError at render
 * time, and the slot error boundary swallows it into a blank page with no
 * console message the app surfaces. Calling the component turns that silence
 * into a failing test.
 *
 * Run: node test/client-render.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const bundlePath = join(here, "..", "lib", "client.js");
const source = readFileSync(bundlePath, "utf8");

const results = [];
function check(label, fn) {
	try {
		fn();
		results.push(`  PASS  ${label}`);
	} catch (error) {
		results.push(`  FAIL  ${label}\n        ${error.message}`);
		process.exitCode = 1;
	}
}

/* --- a React stub: enough for one synchronous render pass ------------- */

function makeReact() {
	const element = (type, props, ...children) => ({ type, props: props ?? {}, children });
	return {
		createElement: element,
		useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
		useEffect: () => {},
		useLayoutEffect: () => {},
		useCallback: (fn) => fn,
		useMemo: (fn) => fn(),
		useRef: (value) => ({ current: value }),
		createContext: () => ({ Provider: "Provider", Consumer: "Consumer" }),
	};
}

/** Load the bundle in a sandbox and hand back the factories it registers. */
function loadFactories() {
	const loaded = new Map();
	const created = [];
	const windowStub = { __ModuleLoader__: { load: (entry) => loaded.set(entry.id, entry.factory) } };
	const sandbox = {
		window: windowStub,
		document: {
			createElement: () => {
				// Kept, so a check can read the stylesheet the plugin injects: some
				// layout bugs (a squashed flex child) are invisible to a render call.
				const element = { style: {}, textContent: "", appendChild() {}, remove() {}, setAttribute() {} };
				created.push(element);
				return element;
			},
			head: { appendChild() {} },
			documentElement: { appendChild() {} },
		},
		fetch: () => Promise.reject(new Error("no server in this test")),
		setInterval: () => 0,
		clearInterval: () => {},
		console,
	};
	windowStub.document = sandbox.document;
	vm.createContext(sandbox);
	vm.runInContext(source, sandbox, { filename: "lib/client.js" });
	return { loaded, created };
}

/** Register every slot the client half offers, with a stub ctx. */
function mount(factory) {
	const react = makeReact();
	const registrations = [];
	const ctx = {
		slots: {
			inject: (_key, callback) => callback(),
			register: (options, Component) => registrations.push({ options, Component }),
		},
		effect: (fn) => fn(),
		get: () => undefined,
		locale: { register: () => {}, bind: () => (key) => key },
	};
	const exports = factory((specifier) =>
		specifier === "react" ? react : {},
	);
	exports.apply(ctx);
	return { registrations, exports };
}

/* --- the test --------------------------------------------------------- */

console.log("dsh-trilogy client-half render test");

const { loaded, created } = loadFactories();

check("the bundle registers exactly one factory under its package id", () => {
	assert.deepEqual([...loaded.keys()], ["dsh-trilogy"]);
});

const factory = loaded.get("dsh-trilogy");
assert.ok(factory, "factory missing — the bundle did not call __ModuleLoader__.load");

let registrations = [];
check("the module exports { name, inject, apply }", () => {
	const { exports } = mount(factory);
	assert.equal(typeof exports.apply, "function", "apply missing");
	assert.equal(exports.name, "dsh-trilogy", "name missing");
	assert.ok(Array.isArray(exports.inject), "inject missing");
});

check("it registers both seats", () => {
	const mounted = mount(factory);
	registrations = mounted.registrations;
	const seats = registrations.map((entry) => entry.options.name).sort();
	assert.deepEqual(seats, ["conversation.input.left", "settings.section"]);
});

check("every registered component renders without throwing", () => {
	assert.ok(registrations.length > 0, "nothing was registered");
	for (const { options, Component } of registrations) {
		// Session-scoped seats receive standard props; supply the two the chip reads.
		const props =
			options.name === "conversation.input.left"
				? { sessionId: "session-1", useSessions: (select) => select({ byId: { "session-1": { cwd: "D:\\example" } } }) }
				: {};
		try {
			Component(props);
		} catch (error) {
			throw new Error(`${options.id ?? options.name} threw while rendering: ${error.message}`);
		}
	}
});

check("the settings section renders its heading rather than nothing", () => {
	const section = registrations.find((entry) => entry.options.name === "settings.section");
	const tree = section.Component({});
	const flat = JSON.stringify(tree);
	assert.ok(flat.includes("项目记忆"), "the settings section rendered no heading");
});

check("the workspace list scrolls instead of squashing its rows", () => {
	// A flex column with a max-height shrinks its children rather than overflowing,
	// so every workspace label ends up clipped top and bottom by its own box.
	const css = created.map((element) => element.textContent).join("\n");
	assert.ok(css.includes(".dsh-pm-item"), "the stylesheet was never injected");
	const item = /\.dsh-pm-item\{[^}]*\}/.exec(css);
	assert.ok(item !== null, "no .dsh-pm-item rule");
	assert.match(item[0], /flex:0 0 auto/, `.dsh-pm-item must not shrink: ${item[0]}`);
	const list = /\.dsh-pm-list\{[^}]*\}/.exec(css);
	assert.ok(list !== null, "no .dsh-pm-list rule");
	assert.match(list[0], /max-height/, "the list is the thing that should overflow");
});

check("the chip stays invisible until it has a reading, and does not throw", () => {
	const chip = registrations.find((entry) => entry.options.name === "conversation.input.left");
	const tree = chip.Component({
		sessionId: "session-1",
		useSessions: (select) => select({ byId: { "session-1": { cwd: "D:\\example" } } }),
	});
	// Rendering nothing before the first status read lands is the intended
	// behaviour: an unread chip must not claim a state it has not observed.
	assert.equal(tree, null, "the chip must render nothing before its first reading");
});

console.log(results.join("\n"));
console.log(process.exitCode === 1 ? "\nRESULT: FAILURES" : "\nRESULT: all checks passed");
