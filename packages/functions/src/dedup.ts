import {
	type Accessor,
	BufferUtils,
	type Document,
	type Material,
	type Mesh,
	Primitive,
	type PrimitiveTarget,
	type Property,
	PropertyType,
	Root,
	type Skin,
	type Texture,
	type Transform,
} from '@gltf-transform/core';
import { assignDefaults, createTransform, shallowEqualsArray } from './utils.js';

const NAME = 'dedup';

export interface DedupOptions {
	/** Keep properties with unique names, even if they are duplicates. */
	keepUniqueNames?: boolean;
	/** List of {@link PropertyType} identifiers to be de-duplicated.*/
	propertyTypes?: string[];
}

const DEDUP_DEFAULTS: Required<DedupOptions> = {
	keepUniqueNames: false,
	propertyTypes: [
		PropertyType.ACCESSOR,
		PropertyType.MESH,
		PropertyType.TEXTURE,
		PropertyType.MATERIAL,
		PropertyType.SKIN,
	],
};

/**
 * Removes duplicate {@link Accessor}, {@link Mesh}, {@link Texture}, and {@link Material}
 * properties. Only accessors in mesh primitives, morph targets, and animation samplers are processed.
 *
 * Example:
 *
 * ```ts
 * document.getRoot().listMeshes(); // → [Mesh, Mesh, Mesh]
 *
 * await document.transform(dedup({propertyTypes: [PropertyType.MESH]}));
 *
 * document.getRoot().listMeshes(); // → [Mesh]
 * ```
 *
 * @category Transforms
 */
export function dedup(_options: DedupOptions = DEDUP_DEFAULTS): Transform {
	const options = assignDefaults(DEDUP_DEFAULTS, _options);

	const propertyTypes = new Set(options.propertyTypes);
	for (const propertyType of options.propertyTypes) {
		if (!DEDUP_DEFAULTS.propertyTypes.includes(propertyType)) {
			throw new Error(`${NAME}: Unsupported deduplication on type "${propertyType}".`);
		}
	}

	return createTransform(NAME, (document: Document): void => {
		const logger = document.getLogger();

		if (propertyTypes.has(PropertyType.ACCESSOR)) dedupAccessors(document);
		if (propertyTypes.has(PropertyType.TEXTURE)) dedupImages(document, options);
		if (propertyTypes.has(PropertyType.MATERIAL)) dedupMaterials(document, options);
		if (propertyTypes.has(PropertyType.MESH)) dedupMeshes(document, options);
		if (propertyTypes.has(PropertyType.SKIN)) dedupSkins(document, options);

		logger.debug(`${NAME}: Complete.`);
	});
}

function dedupAccessors(document: Document): void {
	const logger = document.getLogger();

	// Find all accessors used for mesh and animation data.
	const indicesMap = new Map<string, Set<Accessor>>();
	const attributeMap = new Map<string, Set<Accessor>>();
	const inputMap = new Map<string, Set<Accessor>>();
	const outputMap = new Map<string, Set<Accessor>>();

	const meshes = document.getRoot().listMeshes();
	meshes.forEach((mesh) => {
		mesh.listPrimitives().forEach((primitive) => {
			primitive.listAttributes().forEach((accessor) => hashAccessor(accessor, attributeMap));
			hashAccessor(primitive.getIndices(), indicesMap);
		});
	});

	for (const animation of document.getRoot().listAnimations()) {
		for (const sampler of animation.listSamplers()) {
			hashAccessor(sampler.getInput(), inputMap);
			hashAccessor(sampler.getOutput(), outputMap);
		}
	}

	function hashAccessor(accessor: Accessor | null, group: Map<string, Set<Accessor>>): void {
		if (!accessor) return;

		const hash = [
			accessor.getCount(),
			accessor.getType(),
			accessor.getComponentType(),
			accessor.getNormalized(),
			accessor.getSparse(),
		].join(':');

		let hashSet = group.get(hash);
		if (!hashSet) group.set(hash, (hashSet = new Set<Accessor>()));
		hashSet.add(accessor);
	}

	// Find duplicate accessors of a given type. Accessors are already grouped by structural
	// properties (count, type, componentType, ...), but content may still differ. Hash the
	// content into smaller buckets first, so expensive byte-by-byte comparisons happen only
	// among accessors with matching hashes. Without this, large groups of same-sized accessors
	// (e.g. hundreds of identical vertex buffers) require O(n²) full comparisons.
	function detectDuplicates(accessors: Accessor[], duplicates: Map<Accessor, Accessor>): void {
		if (accessors.length < 2) return;

		const buckets = new Map<string, Accessor[]>();
		for (const accessor of accessors) {
			const hash = hashContent(BufferUtils.toView(accessor.getArray()!));
			let bucket = buckets.get(hash);
			if (!bucket) buckets.set(hash, (bucket = []));
			bucket.push(accessor);
		}

		for (const bucket of buckets.values()) {
			if (bucket.length < 2) continue;

			for (let i = 0; i < bucket.length; i++) {
				const a = bucket[i];

				if (duplicates.has(a)) continue;
				const aData = BufferUtils.toView(a.getArray()!);

				for (let j = i + 1; j < bucket.length; j++) {
					const b = bucket[j];

					if (duplicates.has(b)) continue;

					if (BufferUtils.equals(aData, BufferUtils.toView(b.getArray()!))) {
						duplicates.set(b, a);
					}
				}
			}
		}
	}

	let total = 0;
	const duplicates = new Map<Accessor, Accessor>();
	for (const group of [attributeMap, indicesMap, inputMap, outputMap]) {
		for (const hashGroup of group.values()) {
			total += hashGroup.size;
			detectDuplicates(Array.from(hashGroup), duplicates);
		}
	}

	logger.debug(`${NAME}: Merged ${duplicates.size} of ${total} accessors.`);

	// Dissolve duplicate vertex attributes and indices.
	meshes.forEach((mesh) => {
		mesh.listPrimitives().forEach((primitive) => {
			primitive.listAttributes().forEach((accessor) => {
				if (duplicates.has(accessor)) {
					primitive.swap(accessor, duplicates.get(accessor) as Accessor);
				}
			});
			const indices = primitive.getIndices();
			if (indices && duplicates.has(indices)) {
				primitive.swap(indices, duplicates.get(indices) as Accessor);
			}
		});
	});

	// Dissolve duplicate animation sampler inputs and outputs.
	for (const animation of document.getRoot().listAnimations()) {
		for (const sampler of animation.listSamplers()) {
			const input = sampler.getInput();
			const output = sampler.getOutput();
			if (input && duplicates.has(input)) {
				sampler.swap(input, duplicates.get(input) as Accessor);
			}
			if (output && duplicates.has(output)) {
				sampler.swap(output, duplicates.get(output) as Accessor);
			}
		}
	}

	Array.from(duplicates.keys()).forEach((accessor) => accessor.dispose());
}

function dedupMeshes(document: Document, options: Required<DedupOptions>): void {
	const logger = document.getLogger();
	const root = document.getRoot();

	// Create Reference -> ID lookup table.
	const refs = new Map<Accessor | Material, number>();
	root.listAccessors().forEach((accessor, index) => refs.set(accessor, index));
	root.listMaterials().forEach((material, index) => refs.set(material, index));

	// For each mesh, create a hashkey.
	const numMeshes = root.listMeshes().length;
	const uniqueMeshes = new Map<string, Mesh>();
	for (const src of root.listMeshes()) {
		// For each mesh, create a hashkey.
		const srcKeyItems = [];
		for (const prim of src.listPrimitives()) {
			srcKeyItems.push(createPrimitiveKey(prim, refs));
		}

		// If another mesh exists with the same key, replace all instances with that, and dispose
		// of the duplicate. If not, just cache it.
		let meshKey = '';
		if (options.keepUniqueNames) meshKey += src.getName() + ';';
		meshKey += srcKeyItems.join(';');

		if (uniqueMeshes.has(meshKey)) {
			const targetMesh = uniqueMeshes.get(meshKey)!;
			src.listParents().forEach((parent) => {
				if (parent.propertyType !== PropertyType.ROOT) {
					parent.swap(src, targetMesh);
				}
			});
			src.dispose();
		} else {
			uniqueMeshes.set(meshKey, src);
		}
	}

	logger.debug(`${NAME}: Merged ${numMeshes - uniqueMeshes.size} of ${numMeshes} meshes.`);
}

function dedupImages(document: Document, options: Required<DedupOptions>): void {
	const logger = document.getLogger();
	const root = document.getRoot();
	const textures = root.listTextures();
	const duplicates: Map<Texture, Texture> = new Map();

	// Compare each texture to every other texture — O(n²) — and mark duplicates for replacement.
	for (let i = 0; i < textures.length; i++) {
		const a = textures[i];
		const aData = a.getImage();

		if (duplicates.has(a)) continue;

		for (let j = i + 1; j < textures.length; j++) {
			const b = textures[j];
			const bData = b.getImage();

			if (duplicates.has(b)) continue;

			// URIs are intentionally not compared.
			if (a.getMimeType() !== b.getMimeType()) continue;
			if (options.keepUniqueNames && a.getName() !== b.getName()) continue;

			const aSize = a.getSize();
			const bSize = b.getSize();
			if (!aSize || !bSize) continue;
			if (aSize[0] !== bSize[0]) continue;
			if (aSize[1] !== bSize[1]) continue;
			if (!aData || !bData) continue;
			if (BufferUtils.equals(aData, bData)) {
				duplicates.set(b, a);
			}
		}
	}

	logger.debug(`${NAME}: Merged ${duplicates.size} of ${root.listTextures().length} textures.`);

	Array.from(duplicates.entries()).forEach(([src, dst]) => {
		src.listParents().forEach((property) => {
			if (!(property instanceof Root)) property.swap(src, dst);
		});
		src.dispose();
	});
}

function dedupMaterials(document: Document, options: Required<DedupOptions>): void {
	const logger = document.getLogger();
	const root = document.getRoot();
	const materials = root.listMaterials();
	const duplicates = new Map<Material, Material>();
	const modifierCache = new Map<Material, boolean>();
	const skip = new Set<string>();

	if (!options.keepUniqueNames) {
		skip.add('name');
	}

	for (let i = 0; i < materials.length; i++) {
		const a = materials[i];

		if (duplicates.has(a)) continue;
		if (hasModifier(a, modifierCache)) continue;

		for (let j = i + 1; j < materials.length; j++) {
			const b = materials[j];

			if (duplicates.has(b)) continue;
			if (hasModifier(b, modifierCache)) continue;

			if (a.equals(b, skip)) {
				duplicates.set(b, a);
			}
		}
	}

	logger.debug(`${NAME}: Merged ${duplicates.size} of ${materials.length} materials.`);

	Array.from(duplicates.entries()).forEach(([src, dst]) => {
		src.listParents().forEach((property) => {
			if (!(property instanceof Root)) property.swap(src, dst);
		});
		src.dispose();
	});
}

function dedupSkins(document: Document, options: Required<DedupOptions>): void {
	const logger = document.getLogger();
	const root = document.getRoot();
	const skins = root.listSkins();
	const duplicates = new Map<Skin, Skin>();
	const skip = new Set(['joints']);

	if (!options.keepUniqueNames) {
		skip.add('name');
	}

	for (let i = 0; i < skins.length; i++) {
		const a = skins[i];

		if (duplicates.has(a)) continue;

		for (let j = i + 1; j < skins.length; j++) {
			const b = skins[j];
			if (duplicates.has(b)) continue;

			// Check joints with shallow equality, not deep equality.
			// See: https://github.com/KhronosGroup/glTF-Sample-Models/tree/master/2.0/RecursiveSkeletons
			if (a.equals(b, skip) && shallowEqualsArray(a.listJoints(), b.listJoints())) {
				duplicates.set(b, a);
			}
		}
	}

	logger.debug(`${NAME}: Merged ${duplicates.size} of ${skins.length} skins.`);

	Array.from(duplicates.entries()).forEach(([src, dst]) => {
		src.listParents().forEach((property) => {
			if (!(property instanceof Root)) property.swap(src, dst);
		});
		src.dispose();
	});
}

/**
 * Generates a 64-bit content hash for an accessor's data, used only to bucket candidate
 * duplicates before byte comparison. Collisions are harmless — candidates within a bucket are
 * still compared byte-for-byte — but equal data always produces equal hashes.
 *
 * Hashes 4 bytes at a time through a DataView, so results are independent of the alignment of
 * the underlying ArrayBuffer. Returns two 32-bit words concatenated, reducing collision odds
 * for larger buffers.
 */
function hashContent(view: Uint8Array): string {
	const dataView = new DataView(view.buffer, view.byteOffset, view.byteLength);
	const byteLength = view.byteLength;
	const wordLength = byteLength >>> 2;

	let h1 = 0x811c9dc5;
	let h2 = 0x1b873593;
	for (let i = 0; i < wordLength; i++) {
		const word = dataView.getUint32(i << 2, true);
		h1 = Math.imul(h1 ^ word, 0x01000193) >>> 0;
		h2 = (Math.imul(h2 ^ word, 0x5bd1e995) ^ (h2 >>> 15)) >>> 0;
	}
	for (let i = wordLength << 2; i < byteLength; i++) {
		const byte = view[i];
		h1 = Math.imul(h1 ^ byte, 0x01000193) >>> 0;
		h2 = (Math.imul(h2 ^ byte, 0x5bd1e995) ^ (h2 >>> 15)) >>> 0;
	}

	return `${byteLength}:${h1}:${h2}`;
}

/** Generates a key unique to the content of a primitive or target. */
function createPrimitiveKey(prim: Primitive | PrimitiveTarget, refs: Map<Accessor | Material, number>): string {
	const primKeyItems = [];
	for (const semantic of prim.listSemantics()) {
		const attribute = prim.getAttribute(semantic)!;
		primKeyItems.push(semantic + ':' + refs.get(attribute));
	}
	if (prim instanceof Primitive) {
		const indices = prim.getIndices();
		if (indices) {
			primKeyItems.push('indices:' + refs.get(indices));
		}
		const material = prim.getMaterial();
		if (material) {
			primKeyItems.push('material:' + refs.get(material));
		}
		primKeyItems.push('mode:' + prim.getMode());
		for (const target of prim.listTargets()) {
			primKeyItems.push('target:' + createPrimitiveKey(target, refs));
		}
	}
	return primKeyItems.join(',');
}

/**
 * Detects dependencies modified by a parent reference, to conservatively prevent merging. When
 * implementing extensions like KHR_animation_pointer, the 'modifyChild' attribute should be added
 * to graph edges connecting the animation channel to the animated target property.
 *
 * NOTICE: Implementation is conservative, and could prevent merging two materials sharing the
 * same animated "Clearcoat" ExtensionProperty. While that scenario is possible for an in-memory
 * glTF Transform graph, valid glTF input files do not have that risk.
 */
function hasModifier(prop: Property, cache: Map<Property, boolean>): boolean {
	if (cache.has(prop)) return cache.get(prop)!;

	const graph = prop.getGraph();
	const visitedNodes = new Set<Property>();
	const edgeQueue = graph.listParentEdges(prop);

	// Search dependency subtree for 'modifyChild' attribute.
	while (edgeQueue.length > 0) {
		const edge = edgeQueue.pop()!;
		if (edge.getAttributes().modifyChild === true) {
			cache.set(prop, true);
			return true;
		}

		const child = edge.getChild();
		if (visitedNodes.has(child)) continue;

		for (const childEdge of graph.listChildEdges(child)) {
			edgeQueue.push(childEdge);
		}
	}

	cache.set(prop, false);
	return false;
}
