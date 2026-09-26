# A Workbench workstation in a container: an OpenSSH server with one Unix
# account for each specialist, the host account, and the git account.
#
# The image holds no key. At each start, the entrypoint installs the public
# keys and the host key from /etc/workbench, which setup.sh writes on the
# machine that runs Workbench. See workstation/README.md.
FROM debian:bookworm-slim

# bash, util-linux (setsid --wait, flock), procps (ps), and coreutils are what
# the workstation backend runs. git and openssh-client let an agent reach the
# git account. acl sets the default ACL of the audit folder. sqlite3 and
# python3 are the tools that the specialists use for their data.
RUN apt-get update -q \
	&& DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends \
		openssh-server openssh-client git acl procps util-linux bash coreutils \
		ca-certificates sqlite3 python3 \
	&& rm -rf /var/lib/apt/lists/*

# The tools that find and drive the instruments of the bench:
#   usbutils          lsusb, the USB devices and their classes
#   python3-serial    serial ports: a USB-serial chip or CDC-ACM (/dev/tty*)
#   libusb, pyusb,    USBTMC and other USB instruments through libusb, with
#   pyvisa, pyvisa-py no kernel driver; psutil and zeroconf let pyvisa-py
#   psutil, zeroconf  list the instruments on the network too
#   v4l-utils         v4l2-ctl, the USB cameras (UVC) and their formats
#   gphoto2           the cameras that gphoto2 drives, such as a DSLR
#   nmap              the SCPI ports of the instruments on a subnet
RUN apt-get update -q \
	&& DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends \
		usbutils python3-serial libusb-1.0-0 python3-usb python3-pyvisa \
		python3-pyvisa-py python3-psutil python3-zeroconf v4l-utils gphoto2 nmap \
	&& rm -rf /var/lib/apt/lists/*

COPY accounts /etc/workbench-accounts
COPY sshd_config /etc/ssh/sshd_workbench_config
COPY entrypoint.sh /usr/local/sbin/workbench-entrypoint

# One group holds every account that writes the audit log. Each home has
# mode 0700, so no account reads another account's files. The password `*`
# sets no password and does not lock the account: an sshd without PAM
# refuses a locked account for every method. Instruments also joins the
# device groups: dialout for a serial port, video for a camera, and plugdev
# for a USB device through libusb.
RUN groupadd workbench \
	&& for name in $(grep -v '^#' /etc/workbench-accounts); do \
		useradd --create-home --shell /bin/bash --groups workbench "$name"; \
		usermod --password '*' "$name"; \
		chmod 0700 "/home/$name"; \
	done \
	&& useradd --create-home --shell /bin/bash workbench-git \
	&& usermod --password '*' workbench-git \
	&& chmod 0700 /home/workbench-git \
	&& chmod 0755 /usr/local/sbin/workbench-entrypoint \
	&& usermod --append --groups dialout,video,plugdev instruments

# The entrypoint makes the layout of the workspace at each start: a named
# volume on /srv, /library, or /shared drops the default ACLs of the image.
RUN mkdir -p /run/sshd

EXPOSE 2222
ENTRYPOINT ["/usr/local/sbin/workbench-entrypoint"]
