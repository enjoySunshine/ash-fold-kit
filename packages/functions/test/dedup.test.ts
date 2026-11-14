import { deepEqual, ok, strictEqual } from 'node:assert/strict';
import path from 'node:path';
import { describe, test } from 'node:test';
import { Document, NodeIO, type Property, PropertyType } from '@gltf-transform/core';
import { KHRMaterialsTransmission } from '@gltf-transform/extensions';
import { dedup } from '@gltf-transform/functions';
import ndarray from 'ndarray';
import { savePixels } from 'ndarray-pixels';

describe('functions::dedup', () => {
	test('accessors - geometry', async () => {
		const io = new NodeIO();
		const document = await io.read(path.resolve(import.meta.dirname, 'in/many-cubes.gltf'));
		strictEqual(document.getRoot().listAccessors().length, 1503, 'begins with duplicate accessors');

		dedup({ propertyTypes: [PropertyType.TEXTURE] })(document);

		strictEqual(document.getRoot().listAccessors().length, 1503, 'has no effect when disabled');

		dedup()(document);

		strictEqual(document.getRoot().listAccessors().length, 3, 'prunes duplicate accessors');
	});

	test('accessors - animation', () => {
		const document = new Document();
		const a = document.createAccessor().setArray(new Float32Array([1, 2, 3]));
		const b = document.createAccessor().setArray(new Float32Array([4, 5, 6]));
		const sampler1 = document.createAnimationSampler().setInput(a).setOutput(b);
		const sampler2 = document.createAnimationSampler().setInput(a.clone()).setOutput(b.clone());
		const sampler3 = document.createAnimationSampler().setInput(a.clone()).setOutput(a.clone());
		const prim = document.createPrimitive().setAttribute('POSITION', a.clone());
		document.createMesh().addPrimitive(prim);
		document.createAnimation().addSampler(sampler1).addSampler(sampler2).addSampler(sampler3);

		strictEqual(document.getRoot().listAccessors().length, 7, 'begins with duplicate accessors');

		dedup({ propertyTypes: [PropertyType.TEXTURE] })(document);

		strictEqual(document.getRoot().listAccessors().length, 7, 'has no effect when disabled');

		dedup()(document);

		strictEqual(document.getRoot().listAccessors().length, 4, 'prunes duplicate accessors');
		ok(sampler1.getInput() === a, 'sampler 1 input');
		ok(sampler1.getOutput() === b, 'sampler 1 output');
		ok(sampler2.getInput() === a, 'sampler 2 input');
		ok(sampler2.getOutput() === b, 'sampler 2 output');
		ok(sampler3.getInput() === a, 'sampler 3 input');
		ok(sampler3.getOutput() !== b, 'no mixing input/output');
		ok(sampler3.getOutput() !== b, 'no mixing input/output');
		ok(prim.getAttribute('POSITION') !== a, 'no mixing sampler/attribute');
		ok(prim.getAttribute('POSITION') !== b, 'no mixing sampler/attribute');
	});

	test('materials', () => {
		const document = new Document();
		const root = document.getRoot();

		const mat = document
			.createMaterial('MatA')
			.setBaseColorFactor([0.8, 0.8, 0.8, 1])
			.setAlpha(0.9)
			.setAlphaMode('OPAQUE');
		const matCloned = mat.clone();
		const matRenamed = mat.clone().setName('MatC');
		const matUnequal = mat.clone().setName('MatD').setAlphaMode('MASK');

		ok(mat.equals(matCloned), 'material.equals(material.clone())');

		dedup({ propertyTypes: [] })(document);

		strictEqual(root.listMaterials().length, 4, 'no-op when disabled');

		dedup()(document);

		strictEqual(root.listMaterials().length, 2, 'removes all duplicate materials');
		strictEqual(mat.isDisposed(), false, 'base = ✓');
		ok(matCloned.isDisposed(), 'cloned = ⨉');
		ok(matRenamed.isDisposed(), 'renamed = ⨉');
		strictEqual(matUnequal.isDisposed(), false, 'unequal = ✓');
	});

	test('materials - animation', () => {
		const document = new Document();
		const root = document.getRoot();

		const matA = document
			.createMaterial('MatA')
			.setBaseColorFactor([0.8, 0.8, 0.8, 1])
			.setAlpha(0.9)
			.setAlphaMode('OPAQUE');
		const matB = matA.clone();
		const matC = matA.clone();
		const matD = matA.clone();

		const edgeC = document.getGraph().listChildEdges(matC)[0];
		edgeC.getAttributes().modifyChild = true; // monkeypatch, emulating KHR_animation_pointer.

		const edgeD = document.getGraph().listParentEdges(matD)[0];
		edgeD.getAttributes().modifyChild = true; // monkeypatch, emulating KHR_animation_pointer.

		dedup()(document);

		strictEqual(root.listMaterials().length, 3, 'removes duplicate materials');
		strictEqual(matA.isDisposed(), false, 'base = ✓');
		ok(matB.isDisposed(), 'cloned = ⨉');
		strictEqual(matC.isDisposed(), false, 'animated TextureInfo = ✓');
		strictEqual(matD.isDisposed(), false, 'animated Material = ✓');
	});

	test('meshes', async () => {
		const io = new NodeIO();
		const document = await io.read(path.resolve(import.meta.dirname, 'in/many-cubes.gltf'));
		const root = document.getRoot();
		strictEqual(root.listMeshes().length, 501, 'begins with duplicate meshes');

		dedup({ propertyTypes: [PropertyType.ACCESSOR] })(document);

		strictEqual(root.listMeshes().length, 501, 'has no effect when disabled');

		// Put unique materials on two meshes to prevent merging.
		root.listMeshes()[0].listPrimitives()[0].setMaterial(document.createMaterial('A'));
		root.listMeshes()[1].listPrimitives()[0].setMaterial(document.createMaterial('B'));
		root.listMeshes()[2].listPrimitives()[0].setMaterial(document.createMaterial('C').setRoughnessFactor(0.5));

		dedup()(document);

		strictEqual(root.listMeshes().length, 3, 'prunes duplicate meshes');
	});

	test('skins', async () => {
		const document = new Document();
		const root = document.getRoot();
		const boneA = document.createNode('A');
		const boneB = document.createNode('B');
		document.createScene().addChild(boneA).addChild(boneB);
		const skinA = document.createSkin().addJoint(boneA).addJoint(boneB);
		const skinB = document.createSkin().addJoint(boneA).addJoint(boneB);
		const skinC = document.createSkin().addJoint(boneA);

		strictEqual(root.listSkins().length, 3, 'begins with duplicate skins');

		await document.transform(dedup({ propertyTypes: [PropertyType.MESH] }));

		strictEqual(root.listSkins().length, 3, 'has no effect if disabled');

		await document.transform(dedup({ propertyTypes: [PropertyType.SKIN] }));

		strictEqual(root.listSkins().length, 2, 'prunes duplicate skins');
		strictEqual(skinA.isDisposed(), false, 'keep skin A');
		ok(skinB.isDisposed(), 'dispose skin B');
		strictEqual(skinC.isDisposed(), false, 'keep skin C');
	});

	test('textures', async () => {
		const document = new Document();
		const transmissionExt = document.createExtension(KHRMaterialsTransmission);

		const pixels = ndarray(new Uint8Array(100 * 50 * 4), [100, 50, 4]);
		const image = await savePixels(pixels, 'image/png');

		const tex1 = document.createTexture('copy 1').setMimeType('image/png').setImage(image);
		const tex2 = document.createTexture('copy 2').setMimeType('image/png').setImage(image.slice());

		const transmission = transmissionExt.createTransmission().setTransmissionTexture(tex2);
		const mat = document
			.createMaterial()
			.setBaseColorTexture(tex1)
			.setExtension('KHR_materials_transmission', transmission);

		strictEqual(document.getRoot().listTextures().length, 2, 'begins with duplicate textures');

		dedup({ propertyTypes: [PropertyType.ACCESSOR] })(document);

		strictEqual(document.getRoot().listTextures().length, 2, 'has no effect when disabled');

		dedup()(document);

		strictEqual(document.getRoot().listTextures().length, 1, 'prunes duplicate textures');
		strictEqual(mat.getBaseColorTexture(), tex1, 'retains baseColorTexture');
		strictEqual(transmission.getTransmissionTexture(), tex1, 'retains transmissionTexture');
	});

	test('unique names', async () => {
		const document = new Document();

		const matA = document.createMaterial('A').setBaseColorFactor([0.5, 0.5, 0.5, 1]);
		const matB = matA.clone().setName('B');
		const matC = matA.clone().setName('C').setBaseColorFactor([0.6, 0.6, 0.6, 1]);

		const positionA = document
			.createAccessor()
			.setType('VEC3')
			.setArray(new Float32Array([0, 0, 0]));
		const positionB = document
			.createAccessor()
			.setType('VEC3')
			.setArray(new Float32Array([1, 1, 1]));

		const primA = document.createPrimitive().setAttribute('POSITION', positionA);
		const primB = document.createPrimitive().setAttribute('POSITION', positionB);

		const meshA = document.createMesh('A').addPrimitive(primA);
		const meshB = document.createMesh('B').addPrimitive(primA);
		const meshC = document.createMesh('C').addPrimitive(primB);

		await document.transform(dedup({ keepUniqueNames: true }));

		deepEqual([matA, matB, matC].map(isDisposed), [false, false, false], 'materials - keep unique names');
		deepEqual([meshA, meshB, meshC].map(isDisposed), [false, false, false], 'meshes - keep unique names');

		await document.transform(dedup({ keepUniqueNames: false }));

		deepEqual([matA, matB, matC].map(isDisposed), [false, true, false], 'materials - discard unique names');
		deepEqual([meshA, meshB, meshC].map(isDisposed), [false, true, false], 'meshes - discard unique names');
	});

	test('accessors - large identical groups', () => {
		const document = new Document();
		const root = document.getRoot();

		const COUNT_FLOATS = 18000;
		const base = new Float32Array(COUNT_FLOATS);
		for (let i = 0; i < COUNT_FLOATS; i++) base[i] = ((i * 17) % 97) * 0.01;

		for (let i = 0; i < 90; i++) {
			const array = base.slice();
			if (i >= 12) array[0] = i;
			const position = document.createAccessor().setType('VEC3').setArray(array);
			const index = document
				.createAccessor()
				.setType('SCALAR')
				.setArray(new Uint16Array([0, 1, 2]));
			const prim = document.createPrimitive().setAttribute('POSITION', position).setIndices(index);
			document.createMesh().addPrimitive(prim);
			if (i === 0) prim.setAttribute('COLOR_0', position.clone().setNormalized(true));
		}

		const lastSeven = base.slice();
		lastSeven[COUNT_FLOATS - 1] = 7;
		document
			.createMesh()
			.addPrimitive(
				document
					.createPrimitive()
					.setAttribute('POSITION', document.createAccessor().setType('VEC3').setArray(lastSeven)),
			);

		const at9000 = base.slice();
		at9000[9000] = 3;
		document
			.createMesh()
			.addPrimitive(
				document
					.createPrimitive()
					.setAttribute('POSITION', document.createAccessor().setType('VEC3').setArray(at9000)),
			);

		const inputBase = new Float32Array([0, 1]);
		const outputBase = base.slice(0, 3000);
		for (let i = 0; i < 17; i++) {
			const output = outputBase.slice();
			if (i >= 5 && i <= 15) output[0] = i;
			if (i === 16) output[2999] = 9;
			document
				.createAnimation()
				.addSampler(
					document
						.createAnimationSampler()
						.setInput(document.createAccessor().setType('SCALAR').setArray(inputBase.slice()))
						.setOutput(document.createAccessor().setType('SCALAR').setArray(output)),
				);
		}

		strictEqual(root.listAccessors().length, 217, 'begins with duplicate accessors');

		const t0 = performance.now();
		dedup()(document);
		const t1 = performance.now();

		strictEqual(root.listAccessors().length, 97, 'prunes duplicate accessors');
		ok(t1 - t0 < 2000, 'dedup of large identical groups is not quadratic');

		// 82 = 90 shells (merged: index 0..11 to one, 12..89 unique) + 2 variants.
		const prims = root.listMeshes().flatMap((mesh) => mesh.listPrimitives());
		strictEqual(root.listMeshes().length, 82, 'merges identical meshes');
		strictEqual(prims[0].getAttribute('POSITION').getArray()![0], 0, 'merged shells keep first float 0');
		deepEqual(Array.from(prims[0].getIndices()!.getArray()!), [0, 1, 2], 'indices preserved');

		const positions = root.listAccessors().filter((accessor) => accessor.getType() === 'VEC3');
		strictEqual(positions.length, 82, 'unique POSITION accessors');
		strictEqual(
			positions.some((accessor) => accessor.getArray()![0] === 12),
			true,
			'unique shell 12 survives',
		);
		strictEqual(
			positions.some((accessor) => accessor.getArray()![17999] === 7),
			true,
			'last float 7 survives',
		);
		strictEqual(
			positions.some((accessor) => accessor.getArray()![9000] === 3),
			true,
			'float 9000 = 3 survives',
		);

		const color = prims.find((prim) => prim.getAttribute('COLOR_0'))!.getAttribute('COLOR_0')!;
		strictEqual(color.getNormalized(), true, 'normalized COLOR_0 is not merged into POSITION');

		const samplers = root.listAnimations().flatMap((animation) => animation.listSamplers());
		strictEqual(new Set(samplers.map((sampler) => sampler.getInput())).size, 1, 'merges sampler inputs');
		strictEqual(new Set(samplers.map((sampler) => sampler.getOutput())).size, 13, 'merges sampler outputs');
		const outputs = Array.from(new Set(samplers.map((sampler) => sampler.getOutput())));
		strictEqual(outputs[0].getArray()![0], 0, 'merged outputs keep first float 0');
		strictEqual(
			outputs.some((output) => output.getArray()![0] === 5),
			true,
			'unique output 5 survives',
		);
		strictEqual(
			outputs.some((output) => output.getArray()![2999] === 9),
			true,
			'trailing 9 survives',
		);
	});
});

const isDisposed = (prop: Property) => prop.isDisposed();
