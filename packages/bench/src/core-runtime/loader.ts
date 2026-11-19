import {createHash} from 'node:crypto';
import {readFile,readdir,realpath,stat} from 'node:fs/promises';
import {basename,dirname,join,relative,resolve,sep,isAbsolute} from 'node:path';
import {createRequire,isBuiltin} from 'node:module';
import * as nodeModule from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
import ts from 'typescript';
import {Registry,parsePluginManifest,type ComponentCategory,type PluginManifest,type ComponentManifest,type SuiteCase} from '../../../adapter-api/src/index.ts';

const hash=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');
const canonical=(value:unknown)=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
export interface SelectedComponent {category:ComponentCategory;id:string}
export interface NeutralPluginReference {manifest?:string;package?:string}
export interface LockedFile {path:string;sha256:string}
export interface LockedPackage {name:string;version:string;sha256:string;dependencies:string[]}
export interface ResolvedComponent {category:ComponentCategory;id:string;entry:string;export?:string;identity:string;capabilities:ComponentManifest['capabilities'];manifestId:string}
export interface NeutralPluginResolution {components:ResolvedComponent[];files:LockedFile[];packages:LockedPackage[];manifests:Array<{id:string;identity:string;sha256:string}>;sourceFiles:string[];packageRoots:string[];hasDynamicDependencies:boolean}
const key=(component:SelectedComponent)=>component.category+':'+component.id;
const packageName=(specifier:string)=>specifier.startsWith('@')?specifier.split('/').slice(0,2).join('/'):specifier.split('/')[0];
async function inside(base:string,path:string):Promise<string>{
 const actual=await realpath(resolve(base,path)),boundary=await realpath(base);
 if(actual!==boundary&&!actual.startsWith(boundary+sep))throw new Error('Dependency escapes declared root: '+path);
 if(!(await stat(actual)).isFile())throw new Error('Dependency declaration must name a file: '+path);
 return actual;
}
async function sourcePath(from:string,specifier:string):Promise<string>{
 const requested=resolve(dirname(from),specifier),candidates=[requested];
 if(/\.js$/.test(requested))candidates.push(requested.slice(0,-3)+'.ts',requested.slice(0,-3)+'.tsx');
 if(!/\.[^/]+$/.test(requested))candidates.push(...['.ts','.tsx','.js','.mjs','.cjs','.json','/index.ts','/index.js'].map(suffix=>requested+suffix));
 for(const candidate of candidates)try{if((await stat(candidate)).isFile())return await realpath(candidate);}catch(error){if(!['ENOENT','ENOTDIR'].includes((error as NodeJS.ErrnoException).code??''))throw error;}
 throw new Error('Unavailable source dependency '+specifier+' imported by '+from);
}
/** Inspect actual source imports; type-only imports do not execute and do not enter the runtime closure. */
function references(path:string,source:string):{imports:string[];dynamic:boolean}{
 const imports:string[]=[],tree=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true);let dynamic=false;
 const visit=(node:ts.Node)=>{
  if(ts.isImportDeclaration(node)&&!node.importClause?.isTypeOnly&&ts.isStringLiteral(node.moduleSpecifier)){
   const bindings=node.importClause?.namedBindings,onlyNamedTypes=bindings&&ts.isNamedImports(bindings)&&bindings.elements.length>0&&bindings.elements.every(value=>value.isTypeOnly)&&!node.importClause?.name;
   if(!onlyNamedTypes)imports.push(node.moduleSpecifier.text);
  }
  if(ts.isExportDeclaration(node)&&!node.isTypeOnly&&node.moduleSpecifier&&ts.isStringLiteral(node.moduleSpecifier))imports.push(node.moduleSpecifier.text);
  if(ts.isCallExpression(node)&&(node.expression.kind===ts.SyntaxKind.ImportKeyword||ts.isIdentifier(node.expression)&&node.expression.text==='require')){
   if(node.arguments.length===1&&ts.isStringLiteral(node.arguments[0]))imports.push(node.arguments[0].text);else dynamic=true;
  }
  ts.forEachChild(node,visit);
 };visit(tree);return {imports:[...new Set(imports)],dynamic};
}
async function packageRoot(name:string,anchor:string):Promise<string>{
 const require=createRequire(pathToFileURL(anchor));let entry:string;
 try{entry=require.resolve(name+'/package.json');}catch{try{entry=require.resolve(name);}catch{
  for(const directory of require.resolve.paths(name)??[])try{const path=await realpath(join(directory,name,'package.json')),pkg=JSON.parse(await readFile(path,'utf8'));if(pkg.name===name)return dirname(path);}catch(error){if(!['ENOENT','ENOTDIR'].includes((error as NodeJS.ErrnoException).code??''))throw error;}
  throw new Error('Declared package is not installed: '+name);
 }}
 let directory=dirname(await realpath(entry));
 while(true){try{const pkg=JSON.parse(await readFile(join(directory,'package.json'),'utf8'));if(pkg.name===name)return directory;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const parent=dirname(directory);if(parent===directory)throw new Error('Cannot identify installed package: '+name);directory=parent;
 }
}
function packageManifest(pkg:any):string{const exported=pkg.exports?.['./manifest'],path=typeof exported==='string'?exported:exported?.import??exported?.default;return pkg.webworkbench?.manifest??pkg.webworkbenchManifest??path??'webworkbench.plugin.json';}
async function packageFiles(directory:string):Promise<Array<{path:string;sha256:string}>>{
 const entries:Array<{path:string;sha256:string}>=[];
 const walk=async(current:string)=>{for(const item of (await readdir(current,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
  if(['node_modules','.git'].includes(item.name))continue;const path=join(current,item.name);
  if(item.isDirectory())await walk(path);else if(item.isFile())entries.push({path:relative(directory,path).split(sep).join('/'),sha256:hash(await readFile(path))});
  else if(item.isSymbolicLink())throw new Error('Package contains an unlocked symlink: '+path);
 }};await walk(directory);return entries;
}
interface ManifestPackageSnapshot {files:Array<{path:string;sha256:string}>;dependencies:string[]}
type ManifestPackageCollector=(directory:string,manifestPath:string,manifest:PluginManifest)=>Promise<ManifestPackageSnapshot>;
/** Runtime resolution fields are immutable identity; unrelated dependency declarations are not. */
const packageMetadata=(pkg:any)=>Object.fromEntries(['name','version','type','exports','main','imports','module'].filter(key=>Object.hasOwn(pkg,key)).map(key=>[key,pkg[key]]));
async function declaredPackageManifest(directory:string,pkg:any):Promise<{path:string;manifest:PluginManifest}|undefined>{
 const explicit=!!(pkg.webworkbench?.manifest||pkg.webworkbenchManifest||pkg.exports?.['./manifest']);
 const path=await inside(directory,packageManifest(pkg)).catch(error=>{if(!explicit&&(error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;});
 if(!path)return undefined;return {path,manifest:parsePluginManifest(JSON.parse(await readFile(path,'utf8')))};
}
function packageLocker(collectManifest?:ManifestPackageCollector){
 const packages=new Map<string,LockedPackage>(),paths=new Set<string>(),ordinaryRoots=new Set<string>(),modes=new Map<string,'participant'|'library'>();
 const publish=(locked:LockedPackage,mode:'participant'|'library')=>{
  const identity=locked.name+'@'+locked.version,previous=packages.get(identity);
  // A package also imported as a library needs its complete manifest distribution, rather than just selected components.
  if(previous&&modes.get(identity)==='library'&&mode==='participant'){previous.dependencies=[...new Set([...previous.dependencies,...locked.dependencies])].sort();return;}
  if(previous&&modes.get(identity)===mode&&previous.sha256!==locked.sha256)throw new Error('Conflicting installed package identities: '+identity);
  packages.set(identity,locked);modes.set(identity,mode);
 };
 const lock=async(name:string,anchor:string):Promise<void>=>{
  const directory=await packageRoot(name,anchor);if(paths.has(directory))return;paths.add(directory);
  const packageJSON=join(directory,'package.json'),pkg=JSON.parse(await readFile(packageJSON,'utf8'));if(typeof pkg.name!=='string'||typeof pkg.version!=='string')throw new Error('Installed package lacks name/version identity: '+name);
  const declared=await declaredPackageManifest(directory,pkg);
  if(declared&&collectManifest){
   const snapshot=await collectManifest(directory,declared.path,declared.manifest),content={metadata:packageMetadata(pkg),manifest:declared.manifest,files:snapshot.files.map(file=>({path:relative(directory,file.path).split(sep).join('/'),sha256:file.sha256}))};
   publish({name:pkg.name,version:pkg.version,sha256:hash(canonical(content)),dependencies:[...new Set(snapshot.dependencies)].sort()},'library');return;
  }
  const dependencies:string[]=[];
  for(const dependency of Object.keys(pkg.dependencies??{}).sort()){await lock(dependency,packageJSON);dependencies.push(dependency);}
  for(const dependency of Object.keys(pkg.optionalDependencies??{}).sort())try{await lock(dependency,packageJSON);dependencies.push(dependency);}catch(error){if(!String(error).includes('not installed'))throw error;}
  for(const dependency of Object.keys(pkg.peerDependencies??{}).sort())try{await lock(dependency,packageJSON);dependencies.push(dependency);}catch(error){if(!pkg.peerDependenciesMeta?.[dependency]?.optional)throw error;}
  // Ordinary npm libraries retain their complete content identity; no generic runtime-work exclusion.
  ordinaryRoots.add(directory);publish({name:pkg.name,version:pkg.version,sha256:hash(canonical(await packageFiles(directory))),dependencies:[...new Set(dependencies)].sort()},'library');
 };
 const participant=async(directory:string,projected:unknown,selectedFiles:Set<string>,dependencies:Set<string>)=>{
  const pkg=JSON.parse(await readFile(join(directory,'package.json'),'utf8'));if(typeof pkg.name!=='string'||typeof pkg.version!=='string')throw new Error('Installed package lacks name/version identity');
  const content={metadata:packageMetadata(pkg),manifest:projected,files:await Promise.all([...selectedFiles].sort().map(async path=>({path:relative(directory,path).split(sep).join('/'),sha256:hash(await readFile(path))})))};
  publish({name:pkg.name,version:pkg.version,sha256:hash(canonical(content)),dependencies:[...dependencies].sort()},'participant');
 };
 return {lock,participant,roots:()=>[...ordinaryRoots].sort(),result:()=>[...packages.values()].sort((a,b)=>(a.name+'@'+a.version).localeCompare(b.name+'@'+b.version))};
}
/** Resolve without importing plugin code. Only selected entries and explicit dependencies enter the lock. */
export async function resolveNeutralPlugins(root:string,plugins:NeutralPluginReference[],selection:SelectedComponent[]):Promise<NeutralPluginResolution>{
 const base=await realpath(root),selected=new Map(selection.map(value=>[key(value),value])),found=new Map<string,ResolvedComponent>(),files=new Map<string,string>();
 const manifests:NeutralPluginResolution['manifests']=[],sourceFiles=new Set<string>();let hasDynamicDependencies=false;
 const label=(path:string)=>{const local=relative(base,path);return !local.startsWith('..'+sep)&&!isAbsolute(local)?local.split(sep).join('/'):path;};
 const lockedPackages=packageLocker(async(directory,manifestPath,manifest)=>{
  const collected=new Set<string>(),dependencies=new Set<string>();
  manifests.push({id:'dependency:'+manifest.id,identity:manifest.identity,sha256:hash(canonical(manifest))});
  for(const component of manifest.components){
   const entry=await inside(dirname(manifestPath),component.entry),declared=new Set<string>(),allowedPackages=new Set([...(manifest.dependencies?.packages??[]),...(component.dependencies?.packages??[])]);
   for(const file of [...manifest.dependencies?.files??[],...component.dependencies?.files??[],...component.catalog?[component.catalog]:[]])declared.add(await inside(directory,relative(directory,resolve(dirname(manifestPath),file))));
   const seen=new Set<string>();for(const path of [entry,...declared])await scan(path,allowedPackages,declared,seen,declared.size>0,directory);for(const path of seen)collected.add(path);
   for(const name of allowedPackages){dependencies.add(name);await lockedPackages.lock(name,entry);}
  }
  return {files:await Promise.all([...collected].sort().map(async path=>({path,sha256:hash(await readFile(path))}))),dependencies:[...dependencies]};
 });
 const lockPackage=lockedPackages.lock;
 const scan=async(path:string,allowedPackages:Set<string>,declared:Set<string>,seen:Set<string>,allowDynamic:boolean,boundary:string)=>{
  if(seen.has(path))return;seen.add(path);sourceFiles.add(path);files.set(label(path),hash(await readFile(path)));
  if(!/\.[cm]?[jt]sx?$/.test(path))return;
  const {imports,dynamic}=references(path,await readFile(path,'utf8'));
  hasDynamicDependencies ||= dynamic;
  // Computed imports are trusted only under the complete-files manifest contract.
  if(dynamic&&(!allowDynamic||!declared.has(path)))throw new Error('Unknown dynamic dependency; declare the complete module/data closure including '+label(path));
  for(const dependency of imports){
   if(isBuiltin(dependency))continue;
   if(dependency.startsWith('.')){const child=await sourcePath(path,dependency);if(child!==boundary&&!child.startsWith(boundary+sep))throw new Error('Source dependency escapes plugin root: '+dependency);await scan(child,allowedPackages,declared,seen,allowDynamic,boundary);}
   else if(dependency.startsWith('/')){const candidates=[...declared].filter(file=>basename(file)===basename(dependency));if(!declared.has(path)||candidates.length!==1)throw new Error('Undeclared or ambiguous browser asset dependency: '+dependency);await scan(candidates[0],allowedPackages,declared,seen,allowDynamic,boundary);}
   else{const name=packageName(dependency);if(!allowedPackages.has(name))throw new Error('Undeclared npm dependency: '+name+' in '+label(path));await lockPackage(name,path);}
  }
 };
 for(const reference of plugins){
  if(!!reference.manifest===!!reference.package)throw new Error('Plugin must name one manifest or installed package');
  let manifestPath:string,boundary=base;
  if(reference.package){const directory=await packageRoot(reference.package,join(base,'package.json')),pkg=JSON.parse(await readFile(join(directory,'package.json'),'utf8'));manifestPath=await inside(directory,packageManifest(pkg));boundary=directory;}
  else manifestPath=await inside(base,reference.manifest!);
  const manifest=parsePluginManifest(JSON.parse(await readFile(manifestPath,'utf8'))) as PluginManifest;
  const chosen=manifest.components.filter(component=>selected.has(key(component)));
  if(!chosen.length)continue;
  const projected={schemaVersion:manifest.schemaVersion,apiVersion:manifest.apiVersion,id:manifest.id,identity:manifest.identity,dependencies:manifest.dependencies,components:chosen};
  manifests.push({id:manifest.id,identity:manifest.identity,sha256:hash(canonical(projected))});
  const participantFiles=new Set<string>(),participantDependencies=new Set<string>();
  for(const component of chosen){
   if(found.has(key(component)))throw new Error('Selected component is provided more than once: '+key(component));
   const entry=await inside(dirname(manifestPath),component.entry),dependencyFiles=[...(manifest.dependencies?.files??[]),...(component.dependencies?.files??[]),...('catalog' in component&&typeof component.catalog==='string'?[component.catalog]:[])],declared=new Set<string>();
   for(const file of dependencyFiles)declared.add(await inside(boundary,relative(boundary,resolve(dirname(manifestPath),file))));
   const allowedPackages=new Set([...(manifest.dependencies?.packages??[]),...(component.dependencies?.packages??[])]);
   const seen=new Set<string>();for(const file of [entry,...declared])await scan(file,allowedPackages,declared,seen,declared.size>0,boundary);for(const path of seen)participantFiles.add(path);
   for(const name of allowedPackages){participantDependencies.add(name);await lockPackage(name,entry);}
   found.set(key(component),{category:component.category,id:component.id,entry,...component.export?{export:component.export}:{},identity:component.identity,capabilities:component.capabilities,manifestId:manifest.id});
  }
  if(reference.package)await lockedPackages.participant(boundary,projected,participantFiles,participantDependencies);
 }
 for(const value of selected.values())if(!found.has(key(value)))throw new Error('Selected component is unavailable: '+key(value));
 return {components:[...found.values()].sort((a,b)=>key(a).localeCompare(key(b))),files:[...files].sort(([a],[b])=>a.localeCompare(b)).map(([path,sha256])=>({path,sha256})),packages:lockedPackages.result(),manifests:manifests.sort((a,b)=>a.id.localeCompare(b.id)),sourceFiles:[...sourceFiles].sort(),packageRoots:lockedPackages.roots(),hasDynamicDependencies};
}
/** Host-scoped resolver guard prevents computed imports from escaping a complete manifest declaration. */
export function guardNeutralImports(resolution:NeutralPluginResolution):()=>void {
 type HookContext={parentURL?:string};type HookResult={url:string;[key:string]:unknown};type Hooks={deregister():void};
 const register=(nodeModule as unknown as {registerHooks?: (hooks:{resolve(specifier:string,context:HookContext,next:(specifier:string,context:HookContext)=>HookResult):HookResult})=>Hooks}).registerHooks;
 if(!register){if(resolution.hasDynamicDependencies)throw new Error('Dynamic plugin dependencies require Node with module.registerHooks support');return ()=>{};}
 const sources=new Set(resolution.sourceFiles),roots=resolution.packageRoots;
 const allowed=(path:string)=>sources.has(path)||roots.some(root=>path===root||path.startsWith(root+sep));
 const hook=register({resolve(specifier,context,next){
  const result=next(specifier,context);if(!context.parentURL?.startsWith('file:'))return result;
  const parent=fileURLToPath(context.parentURL);if(!allowed(parent))return result;
  if(result.url.startsWith('node:')||isBuiltin(result.url))return result;
  if(!result.url.startsWith('file:'))throw new Error('Unresolved external dynamic plugin dependency: '+specifier);
  const resolved=fileURLToPath(result.url);if(!allowed(resolved))throw new Error('Unlisted dynamic plugin dependency: '+specifier+' imported by '+parent);
  return result;
 }});return ()=>hook.deregister();
}
export async function withNeutralImportBoundary<T>(resolution:NeutralPluginResolution,operation:()=>Promise<T>):Promise<T>{const release=guardNeutralImports(resolution);try{return await operation();}finally{release();}}
export async function loadNeutralPlugins(resolution:NeutralPluginResolution,registry=new Registry()):Promise<Registry>{
 for(const component of resolution.components){
  const module=await import(pathToFileURL(component.entry).href+'?wwb='+hash(await readFile(component.entry))),adapter=component.export?module[component.export]:module.default??module[component.category];
  if(!adapter||typeof adapter!=='object')throw new Error('Component entry must export its adapter as default: '+component.entry);
  if(canonical(adapter.capabilities)!==canonical(component.capabilities))throw new Error('Loaded component capabilities differ from manifest: '+component.id);
  switch(component.category){case 'suite':registry.registerSuite(component.id,adapter);break;case 'environment':registry.registerEnvironment(component.id,adapter);break;case 'toolProfile':registry.registerToolProfile(component.id,adapter);break;case 'harness':registry.registerHarness(component.id,adapter);break;case 'connector':registry.registerConnector(component.id,adapter);break;}
 }
 return registry;
}
/** Public suite metadata is a JSON resource: planning never executes participant code. */
export async function readSelectedSuiteCatalog(root:string,plugins:NeutralPluginReference[],suiteRef:{adapter:string}):Promise<SuiteCase[]>{
 const base=await realpath(root);let result:SuiteCase[]|undefined;
 for(const reference of plugins){
  let manifestPath:string;
  if(reference.package){const directory=await packageRoot(reference.package,join(base,'package.json')),pkg=JSON.parse(await readFile(join(directory,'package.json'),'utf8'));manifestPath=await inside(directory,packageManifest(pkg));}
  else if(reference.manifest)manifestPath=await inside(base,reference.manifest);else throw new Error('Plugin must name one manifest or installed package');
  const manifest=parsePluginManifest(JSON.parse(await readFile(manifestPath,'utf8'))),component=manifest.components.find(value=>value.category==='suite'&&value.id===suiteRef.adapter);
  if(!component)continue;if(result)throw new Error('Suite is provided more than once: '+suiteRef.adapter);
  const catalog='catalog' in component?component.catalog:undefined;if(typeof catalog!=='string')throw new Error('Selected suite must declare a read-only catalog JSON resource');
  const input=JSON.parse(await readFile(await inside(dirname(manifestPath),catalog),'utf8'));
  if(!Array.isArray(input)||input.some(value=>!value||typeof value.id!=='string'||typeof value.projectKey!=='string'||!/^[a-f0-9]{64}$/.test(value.sha256)||Object.keys(value).some(key=>!['id','projectKey','sha256','metadata'].includes(key))))throw new Error('Invalid suite catalog resource');
  if(new Set(input.map(value=>value.id)).size!==input.length)throw new Error('Duplicate suite catalog task IDs');result=input;
 }
 if(!result)throw new Error('Selected suite is unavailable: '+suiteRef.adapter);return result;
}
/** Core code uses an explicit module closure and has no participant imports. */
export async function neutralCoreFiles(entry:string):Promise<LockedFile[]>{
 const files=new Map<string,string>();
 const scan=async(path:string)=>{path=await realpath(path);if(files.has(path))return;files.set(path,hash(await readFile(path)));if(!/\.[cm]?[jt]sx?$/.test(path))return;for(const reference of references(path,await readFile(path,'utf8')).imports)if(reference.startsWith('.'))await scan(await sourcePath(path,reference));};
 await scan(entry);return [...files].sort(([a],[b])=>a.localeCompare(b)).map(([path,sha256])=>({path,sha256}));
}
export async function neutralCorePackages(files:LockedFile[],additional:Array<{name:string;anchor:string}>=[]):Promise<LockedPackage[]>{
 const locker=packageLocker();for(const {path} of files){if(!/\.[cm]?[jt]sx?$/.test(path))continue;for(const reference of references(path,await readFile(path,'utf8')).imports)if(!reference.startsWith('.')&&!isBuiltin(reference))await locker.lock(packageName(reference),path);}
 for(const {name,anchor} of additional)await locker.lock(name,anchor);
 return locker.result();
}
