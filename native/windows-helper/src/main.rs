use std::env;
#[cfg(windows)]
use std::ffi::c_void;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[cfg(windows)]
use std::mem::size_of;
#[cfg(windows)]
use std::os::windows::io::AsRawHandle;

#[cfg(windows)]
use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, HANDLE, WAIT_OBJECT_0, ERROR_ALREADY_EXISTS};
#[cfg(windows)]
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject, JobObjectExtendedLimitInformation,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
#[cfg(windows)]
use windows_sys::Win32::Security::{FreeSid, PSID, SECURITY_CAPABILITIES};
#[cfg(windows)]
use windows_sys::Win32::Security::Isolation::{
    CreateAppContainerProfile, DeriveAppContainerSidFromAppContainerName,
};
#[cfg(windows)]
use windows_sys::Win32::System::Threading::{
    CreateProcessW, DeleteProcThreadAttributeList, GetExitCodeProcess, InitializeProcThreadAttributeList,
    UpdateProcThreadAttribute, WaitForSingleObject, PROCESS_INFORMATION, STARTUPINFOEXW,
    EXTENDED_STARTUPINFO_PRESENT, INFINITE, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
};

const VERSION: &str = env!("CARGO_PKG_VERSION");
#[cfg(windows)]
const APP_CONTAINER_NAME: &str = "GuardianAgent.Sandbox";

#[derive(Debug, Clone)]
struct CommonOptions {
    profile: String,
    network: String,
    cwd: Option<PathBuf>,
    read_paths: Vec<PathBuf>,
    write_paths: Vec<PathBuf>,
}

#[derive(Debug, Clone)]
enum ParsedCommand {
    Exec { common: CommonOptions, shell_command: String },
    Spawn { common: CommonOptions, command: String, args: Vec<String> },
}

fn main() {
    if let Err(err) = run() {
        eprintln!("{err}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let mut args = env::args().skip(1).collect::<Vec<_>>();
    if args.is_empty() {
        return Err("usage: guardian-sandbox-win [--version|exec|spawn ...]".to_string());
    }

    if args[0] == "--version" {
        println!("guardian-sandbox-win {VERSION}");
        return Ok(());
    }

    #[cfg(not(windows))]
    {
        let _ = args;
        return Err("guardian-sandbox-win only supports Windows targets".to_string());
    }

    #[cfg(windows)]
    {
        let parsed = parse_command(std::mem::take(&mut args))?;
        match parsed {
            ParsedCommand::Exec { common, shell_command } => run_exec(common, shell_command),
            ParsedCommand::Spawn {
                common,
                command,
                args,
            } => run_spawn(common, command, args),
        }
    }
}

#[cfg(windows)]
fn parse_command(args: Vec<String>) -> Result<ParsedCommand, String> {
    let sub = args
        .first()
        .ok_or_else(|| "missing command".to_string())?
        .to_string();
    let mut i = 1usize;
    let mut common = CommonOptions {
        profile: "workspace-write".to_string(),
        network: "off".to_string(),
        cwd: None,
        read_paths: Vec::new(),
        write_paths: Vec::new(),
    };

    while i < args.len() {
        match args[i].as_str() {
            "--profile" => {
                i += 1;
                common.profile = args
                    .get(i)
                    .ok_or_else(|| "missing value for --profile".to_string())?
                    .to_string();
                i += 1;
            }
            "--network" => {
                i += 1;
                common.network = args
                    .get(i)
                    .ok_or_else(|| "missing value for --network".to_string())?
                    .to_string();
                i += 1;
            }
            "--cwd" => {
                i += 1;
                let value = args
                    .get(i)
                    .ok_or_else(|| "missing value for --cwd".to_string())?
                    .to_string();
                common.cwd = Some(PathBuf::from(value));
                i += 1;
            }
            "--read-path" => {
                i += 1;
                let value = args
                    .get(i)
                    .ok_or_else(|| "missing value for --read-path".to_string())?
                    .to_string();
                common.read_paths.push(PathBuf::from(value));
                i += 1;
            }
            "--write-path" => {
                i += 1;
                let value = args
                    .get(i)
                    .ok_or_else(|| "missing value for --write-path".to_string())?
                    .to_string();
                common.write_paths.push(PathBuf::from(value));
                i += 1;
            }
            "--shell-command" if sub == "exec" => {
                i += 1;
                let shell_command = args
                    .get(i)
                    .ok_or_else(|| "missing value for --shell-command".to_string())?
                    .to_string();
                validate_common_options(&common)?;
                return Ok(ParsedCommand::Exec {
                    common,
                    shell_command,
                });
            }
            "--" if sub == "spawn" => {
                i += 1;
                let command = args
                    .get(i)
                    .ok_or_else(|| "spawn command is required after --".to_string())?
                    .to_string();
                let command_args = if i + 1 < args.len() {
                    args[(i + 1)..].to_vec()
                } else {
                    Vec::new()
                };
                validate_common_options(&common)?;
                return Ok(ParsedCommand::Spawn {
                    common,
                    command,
                    args: command_args,
                });
            }
            unknown => {
                return Err(format!("unknown or unsupported flag '{unknown}'"));
            }
        }
    }

    Err(match sub.as_str() {
        "exec" => "missing --shell-command for exec".to_string(),
        "spawn" => "missing -- <command> for spawn".to_string(),
        _ => format!("unsupported command '{sub}'"),
    })
}

#[cfg(windows)]
fn validate_common_options(common: &CommonOptions) -> Result<(), String> {
    if let Some(cwd) = &common.cwd {
        if !common.write_paths.is_empty() {
            let mut allowed = false;
            for root in &common.write_paths {
                if is_within(cwd, root)? {
                    allowed = true;
                    break;
                }
            }
            if !allowed {
                return Err(format!(
                    "cwd '{}' is outside allowed write paths",
                    cwd.display()
                ));
            }
        }
    }

    if common.network.eq_ignore_ascii_case("off") {
        eprintln!(
            "guardian-sandbox-win: network=off requested (host-level per-process network enforcement requires additional OS policy wiring)"
        );
    }
    Ok(())
}

#[cfg(windows)]
fn run_exec(common: CommonOptions, shell_command: String) -> Result<(), String> {
    if should_use_appcontainer(&common) {
        let args = vec![
            "/d".to_string(),
            "/s".to_string(),
            "/c".to_string(),
            shell_command,
        ];
        let code = run_in_appcontainer(&common, "cmd.exe", &args)?;
        std::process::exit(code);
    }

    run_with_standard_spawn(&common, "cmd.exe", &["/d", "/s", "/c", &shell_command])
}

#[cfg(windows)]
fn run_spawn(common: CommonOptions, command_name: String, args: Vec<String>) -> Result<(), String> {
    if should_use_appcontainer(&common) {
        let code = run_in_appcontainer(&common, &command_name, &args)?;
        std::process::exit(code);
    }

    let borrowed_args = args.iter().map(String::as_str).collect::<Vec<_>>();
    run_with_standard_spawn(&common, &command_name, &borrowed_args)
}

#[cfg(windows)]
fn should_use_appcontainer(common: &CommonOptions) -> bool {
    !common.profile.eq_ignore_ascii_case("full-access")
}

#[cfg(windows)]
fn run_with_standard_spawn(common: &CommonOptions, command_name: &str, args: &[&str]) -> Result<(), String> {
    let mut command = Command::new(command_name);
    command
        .args(args)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());

    apply_common_to_command(&mut command, common);

    let mut child = command
        .spawn()
        .map_err(|err| format!("failed to spawn '{command_name}': {err}"))?;
    let job = create_and_assign_job(child.as_raw_handle() as HANDLE)?;
    let status = child
        .wait()
        .map_err(|err| format!("failed while waiting for '{command_name}': {err}"))?;
    close_job(job);
    let code = status.code().unwrap_or(1);
    std::process::exit(code);
}

#[cfg(windows)]
fn apply_common_to_command(command: &mut Command, common: &CommonOptions) {
    command.env("GA_SANDBOX_PROFILE", common.profile.clone());
    command.env("GA_SANDBOX_NETWORK", common.network.clone());
    if let Some(cwd) = &common.cwd {
        command.current_dir(cwd);
    }
}

#[cfg(windows)]
fn run_in_appcontainer(common: &CommonOptions, command_name: &str, args: &[String]) -> Result<i32, String> {
    unsafe {
        let appcontainer_sid = ensure_appcontainer_sid(APP_CONTAINER_NAME)?;
        let mut security_caps: SECURITY_CAPABILITIES = std::mem::zeroed();
        security_caps.AppContainerSid = appcontainer_sid;
        security_caps.Capabilities = std::ptr::null_mut();
        security_caps.CapabilityCount = 0;
        security_caps.Reserved = 0;

        let mut attr_list_size: usize = 0;
        let _ = InitializeProcThreadAttributeList(
            std::ptr::null_mut(),
            1,
            0,
            &mut attr_list_size as *mut usize,
        );
        if attr_list_size == 0 {
            let _ = FreeSid(appcontainer_sid);
            return Err(format!(
                "InitializeProcThreadAttributeList(size query) failed with error code {}",
                GetLastError()
            ));
        }

        let mut attr_list_buffer = vec![0u8; attr_list_size];
        let attr_list = attr_list_buffer.as_mut_ptr() as *mut c_void;
        if InitializeProcThreadAttributeList(attr_list, 1, 0, &mut attr_list_size as *mut usize) == 0 {
            let _ = FreeSid(appcontainer_sid);
            return Err(format!(
                "InitializeProcThreadAttributeList failed with error code {}",
                GetLastError()
            ));
        }

        let update_ok = UpdateProcThreadAttribute(
            attr_list,
            0,
            PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize,
            &mut security_caps as *mut _ as *mut c_void,
            size_of::<SECURITY_CAPABILITIES>(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        );
        if update_ok == 0 {
            let err = GetLastError();
            DeleteProcThreadAttributeList(attr_list);
            let _ = FreeSid(appcontainer_sid);
            return Err(format!(
                "UpdateProcThreadAttribute(PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES) failed with error code {err}"
            ));
        }

        let mut startup_info: STARTUPINFOEXW = std::mem::zeroed();
        startup_info.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
        startup_info.lpAttributeList = attr_list;

        let mut process_info: PROCESS_INFORMATION = std::mem::zeroed();
        let cmdline = build_command_line(command_name, args);
        let mut cmdline_wide = utf16z(&cmdline);
        let cwd_wide = common
            .cwd
            .as_ref()
            .map(|path| utf16z(&path.to_string_lossy()));
        let cwd_ptr = cwd_wide
            .as_ref()
            .map_or(std::ptr::null(), |value| value.as_ptr());

        let created = CreateProcessW(
            std::ptr::null(),
            cmdline_wide.as_mut_ptr(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            1,
            EXTENDED_STARTUPINFO_PRESENT,
            std::ptr::null_mut(),
            cwd_ptr,
            &startup_info.StartupInfo,
            &mut process_info as *mut PROCESS_INFORMATION,
        );

        DeleteProcThreadAttributeList(attr_list);
        let _ = FreeSid(appcontainer_sid);

        if created == 0 {
            return Err(format!(
                "CreateProcessW (AppContainer) failed for '{command_name}' with error code {}",
                GetLastError()
            ));
        }

        let job = create_and_assign_job(process_info.hProcess)?;
        let wait_result = WaitForSingleObject(process_info.hProcess, INFINITE);
        if wait_result != WAIT_OBJECT_0 {
            let err = GetLastError();
            close_job(job);
            let _ = CloseHandle(process_info.hThread);
            let _ = CloseHandle(process_info.hProcess);
            return Err(format!("WaitForSingleObject failed with error code {err}"));
        }

        let mut exit_code: u32 = 1;
        if GetExitCodeProcess(process_info.hProcess, &mut exit_code as *mut u32) == 0 {
            let err = GetLastError();
            close_job(job);
            let _ = CloseHandle(process_info.hThread);
            let _ = CloseHandle(process_info.hProcess);
            return Err(format!("GetExitCodeProcess failed with error code {err}"));
        }

        close_job(job);
        let _ = CloseHandle(process_info.hThread);
        let _ = CloseHandle(process_info.hProcess);
        Ok(exit_code as i32)
    }
}

#[cfg(windows)]
fn ensure_appcontainer_sid(profile_name: &str) -> Result<PSID, String> {
    unsafe {
        let name_w = utf16z(profile_name);
        let mut appcontainer_sid: PSID = std::ptr::null_mut();
        let create_hr = CreateAppContainerProfile(
            name_w.as_ptr(),
            name_w.as_ptr(),
            name_w.as_ptr(),
            std::ptr::null(),
            0,
            &mut appcontainer_sid as *mut PSID,
        );
        if create_hr == 0 {
            return Ok(appcontainer_sid);
        }

        if create_hr as u32 != hresult_from_win32(ERROR_ALREADY_EXISTS) {
            return Err(format!(
                "CreateAppContainerProfile failed with HRESULT 0x{create_hr:08x}"
            ));
        }

        let derive_hr = DeriveAppContainerSidFromAppContainerName(
            name_w.as_ptr(),
            &mut appcontainer_sid as *mut PSID,
        );
        if derive_hr != 0 {
            return Err(format!(
                "DeriveAppContainerSidFromAppContainerName failed with HRESULT 0x{derive_hr:08x}"
            ));
        }
        Ok(appcontainer_sid)
    }
}

#[cfg(windows)]
fn hresult_from_win32(err: u32) -> u32 {
    if err == 0 {
        0
    } else {
        (err & 0x0000_FFFF) | (7 << 16) | 0x8000_0000
    }
}

#[cfg(windows)]
fn build_command_line(command_name: &str, args: &[String]) -> String {
    let mut parts = Vec::with_capacity(args.len() + 1);
    parts.push(quote_windows_arg(command_name));
    for arg in args {
        parts.push(quote_windows_arg(arg));
    }
    parts.join(" ")
}

#[cfg(windows)]
fn quote_windows_arg(value: &str) -> String {
    if value.is_empty() {
        return "\"\"".to_string();
    }
    let needs_quotes = value
        .chars()
        .any(|ch| ch == ' ' || ch == '\t' || ch == '"');
    if !needs_quotes {
        return value.to_string();
    }

    let mut out = String::from("\"");
    let mut slash_count = 0usize;
    for ch in value.chars() {
        if ch == '\\' {
            slash_count += 1;
            continue;
        }
        if ch == '"' {
            out.push_str(&"\\".repeat((slash_count * 2) + 1));
            out.push('"');
            slash_count = 0;
            continue;
        }
        if slash_count > 0 {
            out.push_str(&"\\".repeat(slash_count));
            slash_count = 0;
        }
        out.push(ch);
    }
    if slash_count > 0 {
        out.push_str(&"\\".repeat(slash_count * 2));
    }
    out.push('"');
    out
}

#[cfg(windows)]
fn utf16z(value: &str) -> Vec<u16> {
    let mut wide: Vec<u16> = value.encode_utf16().collect();
    wide.push(0);
    wide
}

#[cfg(windows)]
fn create_and_assign_job(process_handle: HANDLE) -> Result<HANDLE, String> {
    unsafe {
        let job = CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
        if job.is_null() {
            return Err(format!(
                "CreateJobObjectW failed with error code {}",
                GetLastError()
            ));
        }

        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

        let ok = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &mut info as *mut _ as *mut _,
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if ok == 0 {
            let err = GetLastError();
            CloseHandle(job);
            return Err(format!(
                "SetInformationJobObject failed with error code {err}"
            ));
        }

        let assign_ok = AssignProcessToJobObject(job, process_handle);
        if assign_ok == 0 {
            let err = GetLastError();
            CloseHandle(job);
            return Err(format!(
                "AssignProcessToJobObject failed with error code {err}"
            ));
        }

        Ok(job)
    }
}

#[cfg(windows)]
fn close_job(job: HANDLE) {
    unsafe {
        let _ = CloseHandle(job);
    }
}

#[cfg(windows)]
fn is_within(path: &Path, root: &Path) -> Result<bool, String> {
    let path_abs = absolutize(path)?;
    let root_abs = absolutize(root)?;
    Ok(path_abs.starts_with(&root_abs))
}

#[cfg(windows)]
fn absolutize(path: &Path) -> Result<PathBuf, String> {
    if path.is_absolute() {
        Ok(path.to_path_buf())
    } else {
        let cwd = env::current_dir().map_err(|err| format!("failed to resolve current dir: {err}"))?;
        Ok(cwd.join(path))
    }
}
