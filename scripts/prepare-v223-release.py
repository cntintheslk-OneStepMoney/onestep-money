from pathlib import Path
import json

package_path = Path('package.json')
package = json.loads(package_path.read_text(encoding='utf-8'))
if package.get('version') != '2.2.2':
    raise SystemExit(f"package.json: expected 2.2.2, found {package.get('version')!r}")
package['version'] = '2.2.3'
package_path.write_text(json.dumps(package, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')

lock_path = Path('package-lock.json')
lock = json.loads(lock_path.read_text(encoding='utf-8'))
if lock.get('version') != '2.2.2':
    raise SystemExit(f"package-lock.json root: expected 2.2.2, found {lock.get('version')!r}")
root_package = lock.get('packages', {}).get('')
if not isinstance(root_package, dict) or root_package.get('version') != '2.2.2':
    raise SystemExit('package-lock.json packages[\"\"]: expected version 2.2.2')
lock['version'] = '2.2.3'
root_package['version'] = '2.2.3'
lock_path.write_text(json.dumps(lock, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')

changelog_path = Path('CHANGELOG.md')
changelog = changelog_path.read_text(encoding='utf-8')
marker = '## 2.2.2 — Click Interaction Fix\n'
if changelog.count(marker) != 1:
    raise SystemExit(f'CHANGELOG.md: expected one v2.2.2 insertion marker, found {changelog.count(marker)}')
entry = '''## 2.2.3 — Delayed Interaction Fix

### Bug
- Removed browser Popover/top-layer notification presentation that could take pointer input shortly after packaged startup (#145).
- Kept navigation and ordinary controls physically clickable after delayed update-status activity.

### Maintenance
- Removed the experimental preload main-world/global DOM prototype patching used by the v2.2.2 workaround.
- Extended Windows Electron interaction verification to re-test real mouse input after a delayed packaged-style update notification.
- Updated application package and lockfile metadata for v2.2.3.

### Data/Migration
- No stored-data format or migration changes.

### Known Limitations
- Automated interaction coverage models delayed update activity and representative controls; final interactive Windows review remains required.

'''
changelog_path.write_text(changelog.replace(marker, entry + marker, 1), encoding='utf-8')
