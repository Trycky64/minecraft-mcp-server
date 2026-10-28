import { z } from "zod";
import mineflayer from 'mineflayer';
import minecraftData from 'minecraft-data';
import { ToolFactory } from '../tool-factory.js';
import { log } from '../logger.js';
import type { RuntimeRegistryContext } from '../services/runtime-registry-service.js';
import { isUnsafeItemNameStatus, mineflayerItemNameStatus, resolveItemType, runtimeContextKey } from '../services/registry-reporting.js';

const MAX_CRAFT_OPERATION_MS = 15_000;
const activeCraftOperations = new WeakMap<object, Promise<void>>();

/** Bounds the MCP wait while retaining a per-bot lock if Mineflayer settles late. */
export async function boundedCraftOperation(bot: object, execute: () => Promise<void>, timeoutMs = MAX_CRAFT_OPERATION_MS): Promise<void> {
  if (activeCraftOperations.has(bot)) throw new Error('craft-operation-pending-result-uncertain-no-retry');
  const operation = Promise.resolve().then(execute);
  activeCraftOperations.set(bot, operation);
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { timedOut = true; reject(new Error('craft-timeout-result-uncertain-no-retry')); }, timeoutMs);
  });
  const release = () => { if (activeCraftOperations.get(bot) === operation) activeCraftOperations.delete(bot); };
  try {
    await Promise.race([operation, timeout]);
    release();
  } catch (error) {
    if (timedOut) void operation.then(release, release);
    else release();
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

interface RecipeIngredient {
  name: string;
  count: number;
}

interface InventoryItem {
  name: string;
  count: number;
}

type McDataItemsById = Record<string, { name?: unknown }>;

function normalizeItemName(value: string): string {
  return value.trim().toLowerCase();
}

function classifyNameMatch(resultName: string, query: string): { exact: boolean; partial: boolean } {
  const resultNorm = normalizeItemName(resultName);
  const queryNorm = normalizeItemName(query);
  return {
    exact: resultNorm === queryNorm,
    partial: resultNorm.includes(queryNorm)
  };
}

type RecipeEvaluation = {
  canCraft: boolean;
  missingTotal: number;
  missing: RecipeIngredient[];
};

type RecipeIngredientOptions = {
  options: string[];
  count: number;
};

function resolveItemNames(value: unknown, itemsById: McDataItemsById): string[] {
  if (!value) return [];

  if (Array.isArray(value)) {
    const out: string[] = [];
    for (const v of value) {
      const name = resolveItemName(v, itemsById);
      if (name) out.push(name);
    }
    return Array.from(new Set(out));
  }

  const single = resolveItemName(value, itemsById);
  return single ? [single] : [];
}

function parseRecipeIngredientOptions(recipe: unknown, itemsById: McDataItemsById): RecipeIngredientOptions[] {
  if (!recipe) return [];

  const r = recipe as Record<string, unknown>;

  const addOptions = (counts: Map<string, { options: string[]; count: number }>, options: string[]) => {
    if (options.length === 0) return;
    const key = [...options].sort().join('|');
    const existing = counts.get(key);
    if (existing) existing.count += 1;
    else counts.set(key, { options: [...options], count: 1 });
  };

  if (Array.isArray(r.inShape)) {
    const counts = new Map<string, { options: string[]; count: number }>();
    for (const row of r.inShape as unknown[]) {
      if (!Array.isArray(row)) continue;
      for (const cell of row) {
        const options = resolveItemNames(cell, itemsById);
        addOptions(counts, options);
      }
    }
    return Array.from(counts.values());
  }

  if (Array.isArray(r.ingredients)) {
    const counts = new Map<string, { options: string[]; count: number }>();
    for (const ingredient of r.ingredients as unknown[]) {
      const options = resolveItemNames(ingredient, itemsById);
      addOptions(counts, options);
    }
    return Array.from(counts.values());
  }

  return [];
}

function formatOptionsLabel(options: string[]): string {
  if (options.length === 0) return 'unresolved ingredient (no options found)';
  if (options.length === 1) return options[0];

  const shown = options.slice(0, 3).join(', ');
  const suffix = options.length > 3 ? ', …' : '';
  return `one of: ${shown}${suffix}`;
}

function evaluateRecipeMissing(recipe: unknown, inventory: InventoryItem[], itemsById: McDataItemsById): RecipeEvaluation {
  const ingredients = parseRecipeIngredientOptions(recipe, itemsById);
  const missing: RecipeIngredient[] = [];
  let missingTotal = 0;

  for (const { options, count } of ingredients) {
    const have = inventory
      .filter(i => options.includes(i.name))
      .reduce((sum, i) => sum + i.count, 0);

    if (have < count) {
      const deficit = count - have;
      missingTotal += deficit;
      missing.push({ name: formatOptionsLabel(options), count: deficit });
    }
  }

  return { canCraft: missingTotal === 0, missingTotal, missing };
}

type CandidateRecipe = {
  recipe: unknown;
  resultName: string;
  resultCount: number;
  exactMatch: boolean;
  craftingTable?: unknown;
};

function collectCandidateRecipes(recipes: unknown[], query: string, itemsById: McDataItemsById): CandidateRecipe[] {
  const exact: CandidateRecipe[] = [];
  const partial: CandidateRecipe[] = [];

  for (const recipe of recipes) {
    const result = getRecipeResult(recipe, itemsById);
    if (!result) continue;

    const match = classifyNameMatch(result.name, query);
    if (!match.partial) continue;

    const candidate: CandidateRecipe = {
      recipe,
      resultName: result.name,
      resultCount: result.count,
      exactMatch: match.exact
    };

    if (match.exact) exact.push(candidate);
    else partial.push(candidate);
  }

  return exact.length > 0 ? exact : partial;
}

function resolveItemName(value: unknown, itemsById: McDataItemsById): string | null {
  if (!value) return null;

  if (typeof value === 'string') return value;

  if (typeof value === 'number') {
    if (value === 0) return null;
    const item = itemsById[String(value)];
    return typeof item?.name === 'string' ? item.name : null;
  }

  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;

    if (typeof v.name === 'string') return v.name;
    if (typeof v.id === 'number') {
      if (v.id === 0) return null;
      const item = itemsById[String(v.id)];
      return typeof item?.name === 'string' ? item.name : null;
    }
  }

  return null;
}

function parseRecipeIngredients(recipe: unknown, itemsById: McDataItemsById): RecipeIngredient[] {
  const ingredients: RecipeIngredient[] = [];

  if (!recipe) return ingredients;

  const r = recipe as Record<string, unknown>;

  if (Array.isArray(r.inShape)) {
    const countMap: Record<string, number> = {};
    for (const row of r.inShape as unknown[]) {
      if (Array.isArray(row)) {
        for (const item of row) {
          const options = resolveItemNames(item, itemsById);
          if (options.length === 0) continue;
          const label = formatOptionsLabel(options);
          countMap[label] = (countMap[label] || 0) + 1;
        }
      }
    }
    for (const [name, count] of Object.entries(countMap)) {
      ingredients.push({ name, count });
    }

    if (ingredients.length > 0) return ingredients;
  }

  if (Array.isArray(r.ingredients)) {
    const countMap: Record<string, number> = {};
    for (const ingredient of r.ingredients as unknown[]) {
      const options = resolveItemNames(ingredient, itemsById);
      if (options.length === 0) continue;
      const label = formatOptionsLabel(options);
      countMap[label] = (countMap[label] || 0) + 1;
    }
    for (const [name, count] of Object.entries(countMap)) {
      ingredients.push({ name, count });
    }
  }

  return ingredients;
}

function getRecipeResult(recipe: unknown, itemsById: McDataItemsById): { name: string; count: number } | null {
  if (!recipe) return null;

  const r = recipe as Record<string, unknown>;
  const result = r.result;

  if (!result) return null;

  if (typeof result === 'string') {
    return { name: result, count: 1 };
  }

  if (typeof result === 'number') {
    const name = resolveItemName(result, itemsById);
    return name ? { name, count: 1 } : null;
  }

  if (result && typeof result === 'object') {
    const resultObj = result as Record<string, unknown>;
    const name = resolveItemName(resultObj, itemsById);
    const count = typeof resultObj.count === 'number' && Number.isFinite(resultObj.count) ? resultObj.count : 1;
    return name ? { name, count } : null;
  }

  return null;
}

function canCraftRecipe(recipe: unknown, inventory: InventoryItem[], itemsById: McDataItemsById): boolean {
  return evaluateRecipeMissing(recipe, inventory, itemsById).canCraft;
}

function collectCandidateRecipesFromBot(
  bot: mineflayer.Bot,
  mcData: unknown,
  query: string,
  itemsById: McDataItemsById,
  craftingTable: unknown | null
): CandidateRecipe[] {
  const data = mcData as Record<string, unknown>;
  const itemsByName = data.itemsByName as Record<string, { id?: unknown }> | undefined;
  if (!itemsByName) return [];

  const q = normalizeItemName(query);
  const exact: CandidateRecipe[] = [];
  const partial: CandidateRecipe[] = [];

  const pushRecipesFor = (name: string, id: number, exactMatch: boolean) => {
    const recipesFor = (bot as unknown as { recipesFor?: (...args: unknown[]) => unknown[] }).recipesFor;
    if (typeof recipesFor !== 'function') return;
    const recipes = recipesFor(id, null, 1, craftingTable) as unknown[];
    for (const recipe of recipes) {
      const result = getRecipeResult(recipe, itemsById);
      const resultName = result?.name ?? name;
      const resultCount = result?.count ?? 1;
      const candidate: CandidateRecipe = { recipe, resultName, resultCount, exactMatch, craftingTable: craftingTable ?? undefined };
      if (exactMatch) exact.push(candidate);
      else partial.push(candidate);
    }
  };

  const exactEntry = itemsByName[q];
  if (exactEntry && typeof exactEntry.id === 'number') {
    pushRecipesFor(q, exactEntry.id, true);
    return exact;
  }

  for (const [name, meta] of Object.entries(itemsByName)) {
    const match = classifyNameMatch(name, q);
    if (!match.partial) continue;
    if (typeof meta?.id === 'number') pushRecipesFor(name, meta.id, false);
  }

  return partial;
}

function findNearbyCraftingTable(bot: mineflayer.Bot, mcData: unknown): unknown | null {
  const data = mcData as Record<string, unknown>;
  const blocksByName = data.blocksByName as Record<string, { id?: unknown }> | undefined;
  const craftingTableId = blocksByName?.crafting_table?.id;
  if (typeof craftingTableId !== 'number') return null;

  const findBlock = (bot as unknown as { findBlock?: (opts: unknown) => unknown }).findBlock;
  if (typeof findBlock !== 'function') return null;

  try {
    return findBlock({ matching: craftingTableId, maxDistance: 16, count: 1 });
  } catch {
    return null;
  }
}

function getAllRecipes(mcData: unknown): unknown[] {
  const data = mcData as Record<string, unknown>;
  const recipes = data.recipes;

  if (Array.isArray(recipes)) {
    return recipes;
  }

  if (typeof recipes === 'object' && recipes !== null) {
    const recipeObj = recipes as Record<string, unknown>;
    const allRecipes: unknown[] = [];
    for (const recipeList of Object.values(recipeObj)) {
      if (Array.isArray(recipeList)) {
        allRecipes.push(...recipeList);
      }
    }
    return allRecipes;
  }

  return [];
}

/**
 * Recipes, ingredient names and output IDs come from static minecraft-data.
 * Returns a refusal when the current runtime registry shows they do not
 * describe the server's items: a contradicted output, or an inventory stack
 * whose static name Mineflayer could use as an ingredient.
 */
function staticOutputStatus(recipe: unknown, mcData: unknown, itemsById: McDataItemsById, context: RuntimeRegistryContext | null) {
  const result = getRecipeResult(recipe, itemsById);
  const outputId = result ? (mcData as { itemsByName?: Record<string, { id?: unknown }> }).itemsByName?.[result.name]?.id : undefined;
  if (!result || typeof outputId !== 'number') return null;
  return { name: result.name, id: outputId, status: mineflayerItemNameStatus({ type: outputId, name: result.name }, context) };
}

function recipeOutputConflict(recipe: unknown, mcData: unknown, itemsById: McDataItemsById, context: RuntimeRegistryContext | null): string | null {
  const output = staticOutputStatus(recipe, mcData, itemsById, context);
  if (!output || !isUnsafeItemNameStatus(output.status)) return null;
  const runtime = resolveItemType(output.id, context);
  return `recipe-output-contradicted-by-runtime-registry: output ${output.name} (ID ${output.id}) is ${runtime?.status === 'resolved' ? runtime.entry.namespacedId : output.status} on this server`;
}

/** Inventory as recipe evaluation may count it: stacks with contradicted static names are excluded. */
function trustedInventory(bot: mineflayer.Bot, context: RuntimeRegistryContext | null): InventoryItem[] {
  return bot.inventory.items()
    .filter((item) => !isUnsafeItemNameStatus(mineflayerItemNameStatus(item, context)))
    .map((item) => ({ name: item.name, count: item.count }));
}

function recipeProvenanceNote(version: string): string {
  return `Recipe source: static minecraft-data ${version}; recipe shapes and ingredients are not confirmed by the server.`;
}

function runtimeRecipeConflict(bot: mineflayer.Bot, recipe: unknown, mcData: unknown, itemsById: McDataItemsById,
  context: RuntimeRegistryContext | null): string | null {
  if (!context?.registryService) return null;
  const outputConflict = recipeOutputConflict(recipe, mcData, itemsById, context);
  if (outputConflict) return outputConflict;
  const ingredientNames = new Set(parseRecipeIngredientOptions(recipe, itemsById).flatMap(({ options }) => options));
  for (const stack of bot.inventory.items()) {
    if (!ingredientNames.has(stack.name)) continue;
    const status = mineflayerItemNameStatus(stack, context);
    if (!isUnsafeItemNameStatus(status)) continue;
    const runtime = resolveItemType(stack.type, context);
    return `recipe-ingredient-contradicted-by-runtime-registry: slot ${stack.slot} Mineflayer '${stack.name}' (ID ${stack.type}) is ${runtime?.status === 'resolved' ? runtime.entry.namespacedId : status} on this server`;
  }
  return null;
}

export function registerCraftingTools(factory: ToolFactory, getBot: () => mineflayer.Bot,
  getRegistryContext: () => RuntimeRegistryContext | null = () => null): void {
  factory.registerTool(
    "list-recipes",
    "List all available crafting recipes the bot can make with current inventory",
    {
      outputItem: z.string().trim().min(1).optional().describe("Optional: filter recipes by output item name")
    },
    async ({ outputItem }) => {
      const bot = getBot();
      const mcData = minecraftData(bot.version);
      const itemsById = (mcData as unknown as { items: McDataItemsById }).items;
      const recipes = getAllRecipes(mcData);
      const context = getRegistryContext();
      const inventory = trustedInventory(bot, context);

      if (!recipes || recipes.length === 0) {
        return factory.createResponse("No recipes available for this Minecraft version");
      }

      const availableRecipes: Array<{ name: string; count: number; ingredients: RecipeIngredient[]; exactMatch?: boolean }> = [];

      for (const recipe of recipes) {
        const result = getRecipeResult(recipe, itemsById);
        if (!result) continue;

        const match = outputItem ? classifyNameMatch(result.name, outputItem) : { exact: false, partial: true };
        if (outputItem && !match.partial) continue;

        if (canCraftRecipe(recipe, inventory, itemsById) && !recipeOutputConflict(recipe, mcData, itemsById, context)) {
          const ingredients = parseRecipeIngredients(recipe, itemsById);
          availableRecipes.push({
            name: result.name,
            count: result.count,
            ingredients,
            exactMatch: outputItem ? match.exact : undefined
          });
        }
      }

      if (outputItem) {
        const hasExact = availableRecipes.some(r => r.exactMatch);
        if (hasExact) {
          for (let i = availableRecipes.length - 1; i >= 0; i--) {
            if (!availableRecipes[i].exactMatch) availableRecipes.splice(i, 1);
          }
        }
      }

      if (availableRecipes.length === 0) {
        return factory.createResponse(`No craftable recipes found${outputItem ? ` for ${outputItem}` : ''} with current inventory`);
      }

      let output = `Found ${availableRecipes.length} craftable recipe(s):\n\n`;
      availableRecipes.forEach((recipe, index) => {
        output += `${index + 1}. ${recipe.name} (x${recipe.count})\n`;
        output += `   Ingredients: ${recipe.ingredients.map(i => `${i.name} x${i.count}`).join(", ")}\n\n`;
      });
      output += recipeProvenanceNote(bot.version);

      return factory.createResponse(output);
    }
  );

  factory.registerTool(
    "craft-item",
    "Craft an item using a crafting recipe",
    {
      outputItem: z.string().trim().min(1).describe("Name of the item to craft"),
      amount: z.number().int().min(1).max(16).optional().describe("Number of crafting operations (default: 1, maximum: 16 per request)"),
      registryEpoch: z.string().min(1).max(200).optional().describe('Optional registry epoch from the inventory observation; a different current epoch is refused'),
    },
    async ({ outputItem, amount = 1, registryEpoch }) => {
      const outputQuery = normalizeItemName(outputItem);

      const bot = getBot();
      const startContext = getRegistryContext();
      const startContextKey = runtimeContextKey(startContext);
      if (registryEpoch !== undefined && startContext?.registryEpoch !== registryEpoch) {
        return factory.createErrorResponse('stale-registry-epoch: re-list the inventory in the current session before crafting');
      }
      const mcData = minecraftData(bot.version);
      const itemsById = (mcData as unknown as { items: McDataItemsById }).items;
      const recipes = getAllRecipes(mcData);

      if (!recipes || recipes.length === 0) {
        return factory.createErrorResponse("No recipes available");
      }

      let craftedCount = 0;
      let lastError = "";
      let runtimeRefusal: string | null = null;

      const table = findNearbyCraftingTable(bot, mcData);
      const candidatesFromBotNoTable = collectCandidateRecipesFromBot(bot, mcData, outputQuery, itemsById, null);
      const candidatesFromBotWithTable = table ? collectCandidateRecipesFromBot(bot, mcData, outputQuery, itemsById, table) : [];
      const candidatesFromBot = candidatesFromBotNoTable.length > 0 ? candidatesFromBotNoTable : candidatesFromBotWithTable;
      const candidates = candidatesFromBot.length > 0 ? candidatesFromBot : collectCandidateRecipes(recipes, outputQuery, itemsById);

      for (let attempt = 0; attempt < amount; attempt++) {
        const currentInventory = bot.inventory.items().map(item => ({ name: item.name, count: item.count }));
        let craftedThisAttempt = false;
        let bestCannotCraft: { missingTotal: number; message: string } | null = null;

        for (const candidate of candidates) {
          const evaluation = evaluateRecipeMissing(candidate.recipe, currentInventory, itemsById);

          if (!evaluation.canCraft) {
            let msg = `Cannot craft ${candidate.resultName}. Missing:\n`;
            for (const { name, count } of evaluation.missing) {
              msg += `- ${name} x${count}\n`;
            }
            if (!bestCannotCraft || evaluation.missingTotal < bestCannotCraft.missingTotal) {
              bestCannotCraft = { missingTotal: evaluation.missingTotal, message: msg };
            }
            continue;
          }

          // Re-validated before every crafting request, including later operations of the same call.
          if (getBot() !== bot || runtimeContextKey(getRegistryContext()) !== startContextKey) {
            return factory.createErrorResponse(JSON.stringify({
              status: 'craft-stopped-before-action', actionSent: craftedCount > 0, serverConfirmed: false, completedOperations: craftedCount,
              reason: 'runtime-context-changed-before-action: the Minecraft session, bridge session or registry generation changed; re-list the inventory',
            }));
          }
          const conflict = runtimeRecipeConflict(bot, candidate.recipe, mcData, itemsById, getRegistryContext());
          if (conflict) {
            runtimeRefusal ??= conflict;
            continue;
          }

          try {
            if (candidate.craftingTable) {
              await boundedCraftOperation(bot, () => bot.craft(candidate.recipe as Parameters<typeof bot.craft>[0], 1,
                candidate.craftingTable as Parameters<typeof bot.craft>[2]));
            } else {
              await boundedCraftOperation(bot, () => bot.craft(candidate.recipe as Parameters<typeof bot.craft>[0], 1));
            }
            craftedCount++;
            craftedThisAttempt = true;
            log('info', `Crafted ${candidate.resultName}`);
            break;
          } catch (err) {
            lastError = err instanceof Error ? err.message : String(err);
            log('warn', 'Crafting attempt failed after bounded recipe checks.');
            return factory.createErrorResponse(JSON.stringify({
              status: 'craft-result-uncertain-no-retry',
              actionRequested: true,
              actionSent: true,
              serverConfirmed: false,
              completedOperations: craftedCount,
              error: lastError,
              note: 'No alternate recipe or automatic retry was attempted after the crafting request was sent.',
            }));
          }
        }

        if (!craftedThisAttempt && runtimeRefusal) {
          return factory.createErrorResponse(JSON.stringify({
            status: 'craft-refused-runtime-identity', actionSent: craftedCount > 0, serverConfirmed: false,
            completedOperations: craftedCount, reason: runtimeRefusal,
          }));
        }
        if (!craftedThisAttempt && attempt === 0) {
          if (bestCannotCraft) {
            return factory.createErrorResponse(bestCannotCraft.message);
          }
          return factory.createErrorResponse(`Failed to craft ${outputItem}: ${lastError || 'Recipe not found or missing ingredients'}`);
        }

        if (!craftedThisAttempt) {
          break;
        }
      }

      if (craftedCount === 0) {
        return factory.createErrorResponse(`Failed to craft ${outputItem}: ${lastError || "Missing ingredients or recipe not found"}`);
      }

      return factory.createResponse(JSON.stringify({
        status: 'craft-request-completed-client-side',
        actionRequested: true,
        actionSent: true,
        serverConfirmed: false,
        outputItem,
        completedOperations: craftedCount,
        note: 'Mineflayer completed the crafting operation; no independent server-side inventory confirmation was performed.',
      }));
    }
  );

  factory.registerTool(
    "get-recipe",
    "Get detailed information about a specific recipe",
    {
      itemName: z.string().trim().min(1).describe("Name of the item to get recipe for")
    },
    async ({ itemName }) => {
      const bot = getBot();
      const mcData = minecraftData(bot.version);
      const itemsById = (mcData as unknown as { items: McDataItemsById }).items;
      const recipes = getAllRecipes(mcData);
      const context = getRegistryContext();
      const inventory = trustedInventory(bot, context);

      if (!recipes || recipes.length === 0) {
        return factory.createErrorResponse("No recipes available");
      }

      const table = findNearbyCraftingTable(bot, mcData);
      const candidatesFromBotNoTable = collectCandidateRecipesFromBot(bot, mcData, itemName, itemsById, null);
      const candidatesFromBotWithTable = table ? collectCandidateRecipesFromBot(bot, mcData, itemName, itemsById, table) : [];
      const candidatesFromBot = candidatesFromBotNoTable.length > 0 ? candidatesFromBotNoTable : candidatesFromBotWithTable;
      const candidates = candidatesFromBot.length > 0 ? candidatesFromBot : collectCandidateRecipes(recipes, itemName, itemsById);
      const matchingRecipes = candidates
        .map((c) => {
          const ingredients = parseRecipeIngredients(c.recipe, itemsById);
          const evaluation = evaluateRecipeMissing(c.recipe, inventory, itemsById);
          const runtimeConflict = recipeOutputConflict(c.recipe, mcData, itemsById, context);
          return {
            result: c.resultName,
            resultCount: c.resultCount,
            ingredients,
            canCraft: evaluation.canCraft && !runtimeConflict,
            missingTotal: evaluation.missingTotal,
            runtimeConflict,
            outputConfirmed: staticOutputStatus(c.recipe, mcData, itemsById, context)?.status === 'matches-runtime-registry',
          };
        })
        .sort((a, b) => {
          if (a.canCraft !== b.canCraft) return a.canCraft ? -1 : 1;
          return a.missingTotal - b.missingTotal;
        });

      if (matchingRecipes.length === 0) {
        return factory.createResponse(`No recipes found for ${itemName}`);
      }

      let output = `Recipe(s) for ${itemName}:\n\n`;

      matchingRecipes.forEach((recipe, index) => {
        output += `${index + 1}. Output: ${recipe.result} (x${recipe.resultCount})`;
        output += recipe.runtimeConflict ? ` [runtime conflict: ${recipe.runtimeConflict}]` : recipe.canCraft ? ' [craftable]' : ` [missing: ${recipe.missingTotal}]`;
        output += recipe.outputConfirmed ? ' (output ID confirmed by the runtime registry)\n' : '\n';
        output += `   Ingredients:\n`;

        for (const ingredient of recipe.ingredients) {
          output += `   - ${ingredient.name} x${ingredient.count}\n`;
        }
        output += '\n';
      });
      output += recipeProvenanceNote(bot.version);

      return factory.createResponse(output);
    }
  );

  factory.registerTool(
    "can-craft",
    "Check if the bot can craft a specific item with current inventory",
    {
      itemName: z.string().trim().min(1).describe("Name of the item to check")
    },
    async ({ itemName }) => {
      const bot = getBot();
      const mcData = minecraftData(bot.version);
      const itemsById = (mcData as unknown as { items: McDataItemsById }).items;
      const recipes = getAllRecipes(mcData);
      const context = getRegistryContext();
      const inventory = trustedInventory(bot, context);

      if (!recipes || recipes.length === 0) {
        return factory.createErrorResponse("No recipes available");
      }

      const table = findNearbyCraftingTable(bot, mcData);
      const candidatesFromBotNoTable = collectCandidateRecipesFromBot(bot, mcData, itemName, itemsById, null);
      const candidatesFromBotWithTable = table ? collectCandidateRecipesFromBot(bot, mcData, itemName, itemsById, table) : [];
      const candidatesFromBot = candidatesFromBotNoTable.length > 0 ? candidatesFromBotNoTable : candidatesFromBotWithTable;
      const candidates = candidatesFromBot.length > 0 ? candidatesFromBot : collectCandidateRecipes(recipes, itemName, itemsById);
      if (candidates.length === 0) return factory.createResponse(`No recipe found for ${itemName}`);

      let bestCannotCraft: { missingTotal: number; message: string } | null = null;
      let runtimeConflict: string | null = null;

      for (const candidate of candidates) {
        const evaluation = evaluateRecipeMissing(candidate.recipe, inventory, itemsById);
        const conflict = recipeOutputConflict(candidate.recipe, mcData, itemsById, context);
        if (conflict) {
          runtimeConflict ??= conflict;
          continue;
        }

        if (evaluation.canCraft) {
          return factory.createResponse(`Yes, can craft ${candidate.resultName}. Have all required ingredients.\n${recipeProvenanceNote(bot.version)}`);
        }

        let output = `Cannot craft ${candidate.resultName}. Missing:\n`;
        for (const { name, count } of evaluation.missing) {
          output += `- ${name} x${count}\n`;
        }

        if (!bestCannotCraft || evaluation.missingTotal < bestCannotCraft.missingTotal) {
          bestCannotCraft = { missingTotal: evaluation.missingTotal, message: output };
        }
      }

      if (runtimeConflict && !bestCannotCraft) return factory.createResponse(`No, cannot safely craft ${itemName}: ${runtimeConflict}`);
      return factory.createResponse(bestCannotCraft?.message ?? `No recipe found for ${itemName}`);
    }
  );
}
