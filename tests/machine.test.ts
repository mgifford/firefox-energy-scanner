import { describe, it, expect } from 'vitest';
import { energyPreflight, machineName, parseMachine } from '../src/energy/machine.js';
import type { HostFacts } from '../src/energy/probe.js';

const mac = (over: Partial<HostFacts> = {}): HostFacts => ({ platform: 'darwin', arch: 'arm64', virtualised: false, ...over });
const linux = (paranoid: number | undefined, pmu = true): HostFacts => ({
  platform: 'linux',
  arch: 'x64',
  virtualised: false,
  linux: { pmu, events: pmu ? ['cores', 'pkg', 'ram'] : [], ...(paranoid !== undefined ? { paranoid } : {}) },
});

describe('detecting the machine', () => {
  it('recognises an Apple Silicon Mac running native Node', () => {
    const m = parseMachine({ platform: 'darwin', arch: 'arm64', brand: 'Apple M1', arm64: '1', translated: '0' });
    expect(m).toEqual({ platform: 'darwin', arch: 'arm64', cpu: 'Apple M1', appleSilicon: true, rosetta: false });
    expect(machineName(m)).toBe('Apple M1 Mac');
  });

  it('recognises Node running under Rosetta on Apple Silicon', () => {
    const m = parseMachine({ platform: 'darwin', arch: 'x64', brand: 'Apple M2 Pro', arm64: '1', translated: '1' });
    expect(m).toMatchObject({ appleSilicon: true, rosetta: true });
    expect(parseMachine({ platform: 'darwin', arch: 'x64', arm64: '1', translated: '1', firefoxLipo: 'x86_64 arm64\n' }).firefoxArchs).toEqual(['x86_64', 'arm64']);
  });

  it('recognises an Intel Mac, which has no arm64 flag', () => {
    const m = parseMachine({ platform: 'darwin', arch: 'x64', brand: 'Intel(R) Core(TM) i7-8850H CPU @ 2.60GHz', translated: '0' });
    expect(m).toEqual({ platform: 'darwin', arch: 'x64', cpu: 'Intel(R) Core(TM) i7-8850H CPU @ 2.60GHz', appleSilicon: false });
    expect(machineName(m)).toBe('Intel Mac (Intel(R) Core(TM) i7-8850H CPU @ 2.60GHz)');
  });

  it('reads a Linux CPU from /proc/cpuinfo', () => {
    const cpuinfo = 'processor\t: 0\nvendor_id\t: AuthenticAMD\nmodel name\t: AMD Ryzen 7 5800X 8-Core Processor\nflags\t\t: fpu vme\n';
    expect(parseMachine({ platform: 'linux', arch: 'x64', cpuinfo })).toEqual({ platform: 'linux', arch: 'x64', cpu: 'AMD Ryzen 7 5800X 8-Core Processor' });
  });

  it('falls back to the CPU model Node reports', () => {
    expect(parseMachine({ platform: 'win32', arch: 'x64', cpusModel: '  Intel(R) Core(TM) Ultra 7 155H  ' })).toMatchObject({ cpu: 'Intel(R) Core(TM) Ultra 7 155H' });
  });
});

describe('the energy forecast before a scan', () => {
  const m1 = parseMachine({ platform: 'darwin', arch: 'arm64', brand: 'Apple M1', arm64: '1', translated: '0' });

  it('expects Firefox energy on an Apple Silicon Mac, with no setup', () => {
    expect(energyPreflight(m1, mac(), { enabled: true })).toEqual({ level: 'ok', lines: ['Energy: Apple M1 Mac. Firefox measures the energy of its own processes here, with no setup.'] });
  });

  it('warns about Low Power Mode and battery, which change what is measured', () => {
    const p = energyPreflight(m1, mac(), { enabled: true, lowPowerMode: true, onBattery: true });
    expect(p.level).toBe('note');
    expect(p.lines.slice(1).join(' ')).toMatch(/Low Power Mode is on.*Running on battery/);
  });

  it('under Rosetta, warns only when Firefox itself is the Intel build', () => {
    const rosetta = { platform: 'darwin', arch: 'x64', brand: 'Apple M2', arm64: '1', translated: '1' };
    const intelFirefox = energyPreflight(parseMachine({ ...rosetta, firefoxLipo: 'x86_64\n' }), mac({ arch: 'x64' }), { enabled: true });
    expect(intelFirefox.level).toBe('warn');
    expect(intelFirefox.lines.join(' ')).toMatch(/Intel build, which runs translated.*arm64\) build of Node/);
    const nativeFirefox = energyPreflight(parseMachine({ ...rosetta, firefoxLipo: 'arm64' }), mac({ arch: 'x64' }), { enabled: true });
    expect(nativeFirefox.level).toBe('note');
    expect(nativeFirefox.lines[1]).toBe('Node is the Intel build, running under Rosetta. Firefox is the Apple Silicon build, so what it measures is unaffected. The Apple Silicon build of Node is faster.');
    expect(energyPreflight(parseMachine(rosetta), mac({ arch: 'x64' }), { enabled: true }).level).toBe('note');
  });

  it('says a virtual machine cannot measure energy, even an Apple Silicon one', () => {
    const p = energyPreflight(m1, mac({ virtualised: true, hypervisor: 'Apple Virtualization (macOS guest)' }), { enabled: true });
    expect(p.level).toBe('warn');
    expect(p.lines[0]).toBe('Energy: not measurable here. This is a virtual machine (Apple Virtualization (macOS guest)), and virtual machines do not pass power counters through.');
  });

  it('supports an Intel Mac without claiming it is verified', () => {
    const m = parseMachine({ platform: 'darwin', arch: 'x64', brand: 'Intel(R) Core(TM) i5-8259U CPU @ 2.30GHz' });
    const p = energyPreflight(m, mac({ arch: 'x64' }), { enabled: true });
    expect(p.level).toBe('note');
    expect(p.lines.join(' ')).toMatch(/every process on the machine.*not yet verified with this tool/);
  });

  it('tells a Linux PC to fix perf_event_paranoid before the scan, not after', () => {
    const m = parseMachine({ platform: 'linux', arch: 'x64', cpuinfo: 'model name\t: Intel(R) Core(TM) i7-10700 CPU @ 2.90GHz\n' });
    const p = energyPreflight(m, linux(2), { enabled: true });
    expect(p.level).toBe('warn');
    expect(p.lines.join(' ')).toContain('kernel.perf_event_paranoid is 2');
    expect(p.lines.join(' ')).toContain('sudo sysctl kernel.perf_event_paranoid=0');
    expect(energyPreflight(m, linux(0), { enabled: true }).level).toBe('ok');
    expect(energyPreflight(m, linux(undefined, false), { enabled: true }).lines[0]).toMatch(/exposes no RAPL energy counters/);
  });

  it('with --no-energy, says when this machine could have measured energy', () => {
    expect(energyPreflight(m1, mac(), { enabled: false }).lines).toEqual(["Energy: off (--no-energy). This Apple M1 Mac can measure Firefox's energy: leave out --no-energy to include it."]);
    expect(energyPreflight(m1, mac({ virtualised: true }), { enabled: false }).lines).toEqual(['Energy: off (--no-energy).']);
    expect(energyPreflight(parseMachine({ platform: 'linux', arch: 'x64' }), linux(2), { enabled: false }).lines).toEqual(['Energy: off (--no-energy).']);
  });
});
