// CY Desk audio meter: prints what the speakers are playing, as JSON lines on stdout.
// It only reads Windows' peak meters (the levels the volume mixer shows); nothing is
// recorded or captured. Exits when stdin closes (the dashboard went away).
//   {"p":0.42,"app":"chrome","title":"Song - YouTube"}   ~15 times a second while sound plays
//   {"p":0}                                              once a second while silent
// Build: csc /nologo /optimize /out:audiometer.exe audiometer.cs
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorCom { }

[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
  int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
  int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
}

[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
  int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
}

[ComImport, Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioMeterInformation {
  int GetPeakValue(out float peak);
}

[ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionManager2 {
  int GetAudioSessionControl(IntPtr guid, int flags, out IntPtr control);
  int GetSimpleAudioVolume(IntPtr guid, int flags, out IntPtr volume);
  int GetSessionEnumerator(out IAudioSessionEnumerator sessions);
}

[ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionEnumerator {
  int GetCount(out int count);
  int GetSession(int index, out IAudioSessionControl2 session);
}

[ComImport, Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionControl2 {
  int GetState(out int state);
  int GetDisplayName(out IntPtr name);
  int SetDisplayName(IntPtr name, IntPtr ctx);
  int GetIconPath(out IntPtr path);
  int SetIconPath(IntPtr path, IntPtr ctx);
  int GetGroupingParam(out Guid param);
  int SetGroupingParam(IntPtr param, IntPtr ctx);
  int RegisterAudioSessionNotification(IntPtr client);
  int UnregisterAudioSessionNotification(IntPtr client);
  int GetSessionIdentifier(out IntPtr id);
  int GetSessionInstanceIdentifier(out IntPtr id);
  int GetProcessId(out uint pid);
  [PreserveSig] int IsSystemSoundsSession();
}

static class Program {
  static IAudioMeterInformation master;
  static IAudioSessionManager2 sessions;
  static DateTime acquired = DateTime.MinValue;

  static void Acquire() {
    var en = (IMMDeviceEnumerator)new MMDeviceEnumeratorCom();
    IMMDevice dev;
    Marshal.ThrowExceptionForHR(en.GetDefaultAudioEndpoint(0 /* render */, 1 /* multimedia */, out dev));
    object o;
    Guid iidMeter = typeof(IAudioMeterInformation).GUID;
    Marshal.ThrowExceptionForHR(dev.Activate(ref iidMeter, 23, IntPtr.Zero, out o));
    master = (IAudioMeterInformation)o;
    Guid iidSessions = typeof(IAudioSessionManager2).GUID;
    Marshal.ThrowExceptionForHR(dev.Activate(ref iidSessions, 23, IntPtr.Zero, out o));
    sessions = (IAudioSessionManager2)o;
    acquired = DateTime.UtcNow;
  }

  // Loudest non-system session right now: its process id.
  static uint LoudestPid() {
    IAudioSessionEnumerator list;
    if (sessions.GetSessionEnumerator(out list) != 0) return 0;
    int n; list.GetCount(out n);
    float best = 0.001f; uint bestPid = 0;
    for (int i = 0; i < n; i++) {
      IAudioSessionControl2 s;
      if (list.GetSession(i, out s) != 0 || s == null) continue;
      try {
        if (s.IsSystemSoundsSession() == 0) continue; // S_OK means it IS the system sounds session
        float p; ((IAudioMeterInformation)s).GetPeakValue(out p);
        uint pid; s.GetProcessId(out pid);
        if (p > best) { best = p; bestPid = pid; }
      } catch { }
      finally { Marshal.ReleaseComObject(s); }
    }
    Marshal.ReleaseComObject(list);
    return bestPid;
  }

  static string Esc(string s) {
    if (s == null) return "";
    var b = new System.Text.StringBuilder();
    foreach (var c in s) {
      if (c == '"' || c == '\\') b.Append('\\').Append(c);
      else if (c < 32) b.Append(' ');
      else b.Append(c);
    }
    return b.ToString();
  }

  static void Describe(uint pid, out string app, out string title) {
    app = ""; title = "";
    try {
      var p = Process.GetProcessById((int)pid);
      app = p.ProcessName;
      title = p.MainWindowTitle;
      if (string.IsNullOrEmpty(title)) {
        // Browsers play audio from a child process: use a window of the same app.
        foreach (var q in Process.GetProcessesByName(app)) {
          if (!string.IsNullOrEmpty(q.MainWindowTitle)) { title = q.MainWindowTitle; break; }
        }
      }
    } catch { }
  }

  [STAThread]
  static void Main() {
    new Thread(() => { try { while (Console.In.Read() != -1) { } } catch { } Environment.Exit(0); }) { IsBackground = true }.Start();
    string app = "", title = "";
    DateTime lastSilent = DateTime.MinValue, lastDescribe = DateTime.MinValue;
    while (true) {
      try {
        if (master == null || (DateTime.UtcNow - acquired).TotalSeconds > 10) Acquire(); // follows a new default device
        float peak; master.GetPeakValue(out peak);
        if (peak > 0.004f) {
          if ((DateTime.UtcNow - lastDescribe).TotalSeconds > 2) {
            uint pid = LoudestPid();
            if (pid != 0) Describe(pid, out app, out title);
            lastDescribe = DateTime.UtcNow;
          }
          Console.WriteLine("{\"p\":" + peak.ToString("0.000", System.Globalization.CultureInfo.InvariantCulture) +
            ",\"app\":\"" + Esc(app) + "\",\"title\":\"" + Esc(title) + "\"}");
          Thread.Sleep(66);
        } else {
          if ((DateTime.UtcNow - lastSilent).TotalSeconds >= 1) { Console.WriteLine("{\"p\":0}"); lastSilent = DateTime.UtcNow; }
          app = ""; title = ""; lastDescribe = DateTime.MinValue;
          Thread.Sleep(120);
        }
        Console.Out.Flush();
      } catch {
        master = null; sessions = null;
        Thread.Sleep(2000);
      }
    }
  }
}
