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

COPY accounts /etc/workbench-accounts
COPY sshd_config /etc/ssh/sshd_workbench_config
COPY entrypoint.sh /usr/local/sbin/workbench-entrypoint

# One group holds every account that writes the audit log. Each home has
# mode 0700, so no account reads another account's files. The password `*`
# sets no password and does not lock the account: an sshd without PAM
# refuses a locked account for every method.
RUN groupadd workbench \
	&& for name in $(grep -v '^#' /etc/workbench-accounts); do \
		useradd --create-home --shell /bin/bash --groups workbench "$name"; \
		usermod --password '*' "$name"; \
		chmod 0700 "/home/$name"; \
	done \
	&& useradd --create-home --shell /bin/bash workbench-git \
	&& usermod --password '*' workbench-git \
	&& chmod 0700 /home/workbench-git \
	&& chmod 0755 /usr/local/sbin/workbench-entrypoint

# The entrypoint makes the layout of the workspace at each start: a named
# volume on /srv, /library, or /shared drops the default ACLs of the image.
RUN mkdir -p /run/sshd

EXPOSE 2222
ENTRYPOINT ["/usr/local/sbin/workbench-entrypoint"]
